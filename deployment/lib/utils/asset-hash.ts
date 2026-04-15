/**
 * Asset Hash Utility
 * Computes deterministic SHA-256 hashes from specific source files/directories.
 * Used to give CDK precise asset hashes so that assets are only rebuilt
 * when their actual source inputs change (not unrelated project files).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Recursively list all files in a directory */
function listFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name); // nosemgrep: path-join-resolve-traversal
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Compute a deterministic SHA-256 hash from a list of files and directories.
 * For directories, all files are recursively included.
 * Paths are sorted for determinism across runs.
 */
export function computeSourceHash(...paths: string[]): string {
  const hash = crypto.createHash('sha256');
  const allFiles: string[] = [];

  for (const p of paths) {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      allFiles.push(...listFiles(p));
    } else {
      allFiles.push(p);
    }
  }

  for (const file of allFiles.sort()) {
    hash.update(file);
    hash.update(fs.readFileSync(file));
  }

  return hash.digest('hex');
}
