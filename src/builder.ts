import {BuilderContext, BuilderOutput, createBuilder} from '@angular-devkit/architect';
import {basename, dirname, join, JsonObject, normalize} from '@angular-devkit/core';
import {mergeWithMapping} from 'xliff-simple-merge/dist/src/merge';
import {promises as fs} from 'fs';
import {xmlNormalize} from 'xml_normalize/dist/src/xmlNormalize';
import {XmlDocument, XmlElement} from 'xmldoc';
import {Evaluator} from 'xml_normalize/dist/src/xpath/simpleXPath';

export interface Options extends JsonObject {
    format: 'xlf' | 'xlif' | 'xliff' | 'xlf2' | 'xliff2' | null
    outputPath: string | null,
    sourceFile: string | null,
    targetFiles: string[],
    sourceLanguageTargetFile: string | null,
    removeIdsWithPrefix: string[] | null,
    fuzzyMatch: boolean,
    resetTranslationState: boolean,
    collapseWhitespace: boolean,
    includeContext: boolean,
    newTranslationTargetsBlank: boolean | 'omit',
    sort: 'idAsc' | 'stableAppendNew'
}

export default createBuilder(copyFileBuilder);

function resetSortOrder(originalTranslationSourceFile: string, updatedTranslationSourceFile: string, idPath: string, idMapping: { [oldId: string]: string }): string {
    const originalDocEval = new Evaluator(new XmlDocument(originalTranslationSourceFile));
    const originalIdsOrder = originalDocEval.evalValues(idPath).map(id => idMapping[id] ?? id);

    const updatedTranslationSourceDoc = new XmlDocument(updatedTranslationSourceFile);
    const translationUnitsParentPath = idPath.replace(new RegExp('/[^/]*/@id$'), '');
    const translationUnitsParent = new Evaluator(updatedTranslationSourceDoc).evalNodeSet(translationUnitsParentPath)[0];

    translationUnitsParent.children = translationUnitsParent.children
        .filter((n): n is XmlElement => n.type === 'element') // filter out text (white space)
        .sort((a, b) => {
            const indexA = originalIdsOrder.indexOf(a.attr.id);
            const indexB = originalIdsOrder.indexOf(b.attr.id);
            if (indexA === -1 && indexB === -1) {
                return a.attr.id.toLowerCase().localeCompare(b.attr.id.toLowerCase());
            } else if (indexA === -1) {
                return 1;
            } else if (indexB === -1) {
                return -1;
            } else {
                return indexA - indexB;
            }
        });
    translationUnitsParent.firstChild = translationUnitsParent.children[0];
    translationUnitsParent.lastChild = translationUnitsParent.children[translationUnitsParent.children.length - 1];

    // retain xml declaration:
    const xmlDecMatch = updatedTranslationSourceFile.match(/^<\?xml [^>]*>\s*/i);
    const xmlDeclaration = xmlDecMatch ? xmlDecMatch[0] : '';

    // we need to reformat the xml (whitespaces are messed up by the sort):
    return xmlNormalize({
        in: xmlDeclaration + updatedTranslationSourceDoc.toString({preserveWhitespace: true, compressed: true}),
        trim: false,
        normalizeWhitespace: true
    });
}

async function copyFileBuilder(options: Options, context: BuilderContext): Promise<BuilderOutput> {
    context.logger.info(`Running ng-extract-i18n-merge for project ${context.target?.project}`);

    console.debug = () => null; // prevent debug output from xml_normalize and xliff-simple-merge
    const extractI18nTarget = {target: 'extract-i18n', project: context.target?.project!};
    const extractI18nOptions = await context.getTargetOptions(extractI18nTarget);
    context.logger.debug(`options: ${JSON.stringify(options)}`);
    context.logger.debug(`extractI18nOptions: ${JSON.stringify(extractI18nOptions)}`);
    const outputPath = options.outputPath as string || extractI18nOptions.outputPath as string || '.';
    const format = options.format as string || extractI18nOptions.format as string || 'xlf';
    const isXliffV2 = format.includes('2');

    context.logger.info('running "extract-i18n" ...');
    const sourcePath = join(normalize(outputPath), options.sourceFile ?? 'messages.xlf');
    const translationSourceFileOriginal = await fs.readFile(sourcePath, 'utf8');

    const extractI18nRun = await context.scheduleTarget(extractI18nTarget, {
        outputPath: dirname(sourcePath),
        outFile: basename(sourcePath),
        format,
        progress: false
    });
    const extractI18nResult = await extractI18nRun.result;
    if (!extractI18nResult.success) {
        return {success: false, error: `"extract-i18n" failed: ${extractI18nResult.error}`};
    }
    context.logger.info(`extracted translations successfully`);

    context.logger.info(`normalize ${sourcePath} ...`);
    const translationSourceFile = await fs.readFile(sourcePath, 'utf8');
    const removePaths = [
        ...(options.includeContext ? [] : [isXliffV2 ? '/xliff/file/unit/notes' : '/xliff/file/body/trans-unit/context-group']),
        ...(options.removeIdsWithPrefix ?? []).map(removePrefix => isXliffV2 ? `/xliff/file/unit[starts-with(@id,"${removePrefix}")]` : `/xliff/file/body/trans-unit[starts-with(@id,"${removePrefix}")]`)
    ];
    const idPath = isXliffV2 ? '/xliff/file/unit/@id' : '/xliff/file/body/trans-unit/@id';
    const sort: Options['sort'] = options.sort ?? 'idAsc';
    const normalizedTranslationSourceFile = xmlNormalize({
        in: translationSourceFile,
        trim: false,
        normalizeWhitespace: true,
        sortPath: sort === 'idAsc' ? idPath : undefined,
        removePath: removePaths
    });

    let idMapping: { [id: string]: string } = {};

    for (const targetFile of options.targetFiles) {
        const targetPath = join(normalize(outputPath), targetFile);
        context.logger.info(`merge and normalize ${targetPath} ...`);
        const translationTargetFile = await fs.readFile(targetPath, 'utf8');
        const [mergedTarget, mapping] = mergeWithMapping(normalizedTranslationSourceFile, translationTargetFile, {
            ...options,
            syncTargetsWithInitialState: true,
            sourceLanguage: targetFile === options.sourceLanguageTargetFile
        });
        const normalizedTarget = xmlNormalize({
            in: mergedTarget,
            trim: false,
            normalizeWhitespace: true,
            // no sorting for 'stableAppendNew' as this is the default merge behaviour:
            sortPath: sort === 'idAsc' ? idPath : undefined,
            removePath: removePaths
        });
        await fs.writeFile(targetPath, normalizedTarget);
        idMapping = {...idMapping, ...mapping};
    }

    if (sort === 'stableAppendNew') {
        const normalizedTranslationSourceFileWithStableSorting = resetSortOrder(translationSourceFileOriginal, normalizedTranslationSourceFile, idPath, idMapping);
        await fs.writeFile(sourcePath, normalizedTranslationSourceFileWithStableSorting);
    } else {
        await fs.writeFile(sourcePath, normalizedTranslationSourceFile);
    }

    context.logger.info('finished i18n merging and normalizing');
    return {success: true};
}
