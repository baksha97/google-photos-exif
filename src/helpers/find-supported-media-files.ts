import { existsSync } from 'fs';
import { basename, extname, resolve } from 'path';
import { CONFIG } from '../config';
import { MediaFileInfo } from '../models/media-file-info';
import { doesFileSupportExif } from './does-file-support-exif';
import { findFilesWithExtensionRecursively } from './find-files-with-extension-recursively';
import { generateUniqueOutputFileName } from './generate-unique-output-file-name';
import { getCompanionJsonPathForMediaFile } from './get-companion-json-path-for-media-file';

export async function* findSupportedMediaFiles(inputDir: string, outputDir?: string): AsyncGenerator<MediaFileInfo> {
  const supportedMediaFileExtensions = CONFIG.supportedMediaFileTypes.map(fileType => fileType.extension);

  const allUsedOutputFilesLowerCased = new Set<string>();

  for await (const mediaFilePath of findFilesWithExtensionRecursively(inputDir, supportedMediaFileExtensions)) {
    const mediaFileName = basename(mediaFilePath);
    const mediaFileExtension = extname(mediaFilePath);
    const supportsExif = doesFileSupportExif(mediaFilePath);

    const jsonFilePath = getCompanionJsonPathForMediaFile(mediaFilePath);
    const jsonFileName = jsonFilePath ? basename(jsonFilePath) : null;
    const jsonFileExists = jsonFilePath ? existsSync(jsonFilePath) : false;

    const outputFileName = outputDir ? generateUniqueOutputFileName(mediaFilePath, allUsedOutputFilesLowerCased) : mediaFileName;
    const outputFilePath = outputDir ? resolve(outputDir, outputFileName) : mediaFilePath;

    const mediaFileInfo: MediaFileInfo = {
      mediaFilePath,
      mediaFileName,
      mediaFileExtension,
      supportsExif,
      jsonFilePath,
      jsonFileName,
      jsonFileExists,
      outputFileName,
      outputFilePath,
    };

    allUsedOutputFilesLowerCased.add(outputFileName.toLowerCase());
    yield mediaFileInfo;
  }
}
