import { ExifTool } from 'exiftool-vendored';
import { doesFileSupportExif } from './does-file-support-exif';
import { promises as fspromises } from 'fs';
import { MediaFileInfo } from '../models/media-file-info';
import { resolve } from 'path';

const { unlink, copyFile } = fspromises;

export async function updateExifMetadata(fileInfo: MediaFileInfo, timeTaken: string, errorDir: string | undefined, exiftool: ExifTool): Promise<boolean> {
  if (!doesFileSupportExif(fileInfo.outputFilePath)) {
    return true;
  }

  try {
    await exiftool.write(fileInfo.outputFilePath, {
      DateTimeOriginal: timeTaken,
    });

    await unlink(`${fileInfo.outputFilePath}_original`); // exiftool will rename the old file to {filename}_original, we can delete that
    return true;

  } catch (error) {
    if (errorDir) {
      await copyFile(fileInfo.outputFilePath, resolve(errorDir, fileInfo.mediaFileName));
      if (fileInfo.jsonFileExists && fileInfo.jsonFileName && fileInfo.jsonFilePath) {
        await copyFile(fileInfo.jsonFilePath, resolve(errorDir, fileInfo.jsonFileName));
      }
    }
    return false;
  }
}
