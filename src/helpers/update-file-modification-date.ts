import { promises as fspromises } from 'fs';

const { utimes, open } = fspromises;

export async function updateFileModificationDate(filePath: string, timeTaken: string): Promise<void> {
  const time = new Date(timeTaken);

  try {
    await utimes(filePath, time, time);
  } catch (error) {
    const fh = await open(filePath, 'w');
    await fh.close();
  }
}
