import type { Compilation } from 'webpack';
import type {
    default as HtmlWebpackPluginInstance,
    HtmlTagObject,
} from 'html-webpack-plugin';


type AlterAssetTagGroupsHookParam = Parameters<Parameters<HtmlWebpackPluginInstance.Hooks['alterAssetTagGroups']['tapAsync']>[1]>[0];

type EntryName = string;
type File = string;
type ParentChunkFile = string;

export function addLinkForEntryPointWebpackPreload(
    compilation: Compilation,
    htmlPluginData: AlterAssetTagGroupsHookParam,
) {

    if (htmlPluginData.plugin.options?.inject === false) {
        return;
    }
    
    // Html can contain multiple entrypoints, entries contains preloaded ChunkGroups, ChunkGroups contains chunks, chunks contains files.
    // Files are what we need.

    const entryFileMap = prepareEntryFileMap(compilation, htmlPluginData);

    // Prepare link tags for HtmlWebpackPlugin
    const publicPath = getPublicPath(compilation, htmlPluginData);
    const entryHtmlTagObjectMap = generateHtmlTagObject(entryFileMap, publicPath, compilation);

    // Related files's link tags should follow parent script tag
    // according to this [blog](https://web.dev/priority-hints/#using-preload-after-chrome-95).
    alterAssetTagGroups(entryHtmlTagObjectMap, compilation, htmlPluginData);
}

function getInjectPos(htmlPluginData: AlterAssetTagGroupsHookParam) {
    if (htmlPluginData.plugin.options?.inject === 'body') {
        return 'bodyTags';
    }
    if (htmlPluginData.plugin.options?.inject === 'head') {
        return 'headTags';
    }

    if (htmlPluginData.plugin.options?.inject === false) {
        return false;
    }
    
    if (htmlPluginData.plugin.options?.inject === true && htmlPluginData.plugin.options?.scriptLoading === 'blocking') {
        return 'bodyTags';
    }
    return 'headTags';
}

function alterAssetTagGroups(entryHtmlTagObjectMap: Map<EntryName, Map<HtmlTagObject, Array<ParentChunkFile>>>, compilation: Compilation, htmlPluginData: AlterAssetTagGroupsHookParam) {
    const injectPos = getInjectPos(htmlPluginData);
    if (injectPos === false) {
        return;
    }
    for (const [entryName, linkTagsWithParentId] of entryHtmlTagObjectMap) {
        for (const [linkTag, parentFiles] of linkTagsWithParentId) {
            let insertIndex = -1;
            for (const parentFile of parentFiles) {
                const findLastFileScriptTagIndex = tag => tag.tagName === 'script' && (tag.attributes.src as string).indexOf(parentFile) !== -1;
                const linkIndex = htmlPluginData[injectPos].findIndex(
                    findLastFileScriptTagIndex
                );
                insertIndex = linkIndex > insertIndex ? linkIndex : insertIndex;
            }
            if (insertIndex === -1) {
                console.warn(`cannot find entrypoints\'s script tags for entry: ${entryName}, files: ${parentFiles}`);
                continue;
            };
            htmlPluginData.headTags.splice(insertIndex+1, 0, linkTag);
        }
    }
}

/**
 * Get entrypoints related preload files' names
 * 
 * Html can contain multiple entrypoints, entries contains preloaded ChunkGroups, ChunkGroups contains chunks, chunks contains files.
 * Files are what we need.
 * @param compilation 
 * @param htmlPluginData 
 */
function prepareEntryFileMap(
    compilation: Compilation,
    htmlPluginData: AlterAssetTagGroupsHookParam) {
    const entryFileMap = new Map<EntryName, Map<File, Array<ParentChunkFile>>>;

    const entries = htmlPluginData.plugin.options?.chunks ?? 'all';
    let entriesKeys = Array.isArray(entries) ? entries : Array.from(compilation.entrypoints.keys());

    for (const key of entriesKeys) {
        const preloaded = compilation.entrypoints.get(key)?.getChildrenByOrders(compilation.moduleGraph, compilation.chunkGraph).preload;
        if (!preloaded) continue;
        entryFileMap.set(key, new Map());
        // cannot get font files in `preload`
        for (const group of preloaded) { // the order of preloaded is relevant
            for (const chunk of group.chunks) {
                const parentChunkFiles = group.getParents().flatMap(c => c.getFiles());
                for (const file of chunk.files) {
                    entryFileMap.get(key)?.set(file, parentChunkFiles);
                };
            }
        }
    }

    return entryFileMap;
}

/**
 * Generate HtmlTagObjects for HtmlWebpackPlugin
 * @param entryFileMap 
 * @param publicPath 
 * @returns 
 */
function generateHtmlTagObject(entryFileMap: Map<EntryName, Map<File, Array<ParentChunkFile>>>, publicPath: string, compilation: Compilation): Map<EntryName, Map<HtmlTagObject, Array<ParentChunkFile>>> {
    const map = new Map<EntryName, Map<HtmlTagObject, Array<ParentChunkFile>>>();
    for (const [key, fileParentsMap] of entryFileMap) {
        const linkTagWithParentFiles = new Map<HtmlTagObject, Array<ParentChunkFile>>();
        map.set(key, linkTagWithParentFiles);
        fileParentsMap.forEach((parentFiles, fileName) => {
            const href = `${publicPath}${fileName}`;
            const as = getTypeOfResource(fileName);
            const crossOrigin = as === 'font' ? 'anonymous' : compilation.outputOptions.crossOriginLoading;
            let attributes: HtmlTagObject['attributes'] = {
                rel: 'preload',
                href,
                as
            }
            if (crossOrigin) {
                attributes = { ...attributes, crossorigin: crossOrigin }
            }
            const linkTag = {
                tagName: 'link',
                attributes,
                voidTag: true,
                meta: {
                    plugin: 'html-webpack-inject-preload',
                },
            }
            linkTagWithParentFiles.set(linkTag, parentFiles);
        });
    }
    return map;
}

function getTypeOfResource(fileName: String) {
    if (fileName.match(/.js$/)) {
        return 'script'
    }
    if (fileName.match(/.css$/)) {
        return 'style'
    }
    if (fileName.match(/.(woff2|woff|ttf|otf)$/)) {
        return 'font'
    }
    if (fileName.match(/.(gif|jpeg|png|svg)$/)) {
        return 'image'
    }
}

function getPublicPath(compilation: Compilation, htmlPluginData: AlterAssetTagGroupsHookParam) {
    //Get public path
    //html-webpack-plugin v5
    let publicPath = htmlPluginData.publicPath;

    //html-webpack-plugin v4
    if (typeof publicPath === 'undefined') {
        if (
            htmlPluginData.plugin.options?.publicPath &&
            htmlPluginData.plugin.options?.publicPath !== 'auto'
        ) {
            publicPath = htmlPluginData.plugin.options?.publicPath;
        } else {
            publicPath =
                typeof compilation.options.output.publicPath === 'string'
                    ? compilation.options.output.publicPath
                    : '/';
        }

        //prevent wrong url
        if (publicPath[publicPath.length - 1] !== '/') {
            publicPath = publicPath + '/';
        }
    }
    return publicPath;
}