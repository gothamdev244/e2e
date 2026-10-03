import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathSpecifier, pathTarget } from '../../src/config/specifiers.ts';

describe('pathTarget', () => {
  it.each([
    ['an absolute path', 'C:\\app\\lib\\helper', 'C:\\app\\lib\\helper'],
    ['a relative path with backslashes', '.\\helper', 'C:\\app\\lib\\helper'],
    ['a parent-relative path', '..\\shared\\seed', 'C:\\app\\shared\\seed'],
    ['a relative path with forward slashes', './helper', 'C:\\app\\lib\\helper'],
  ])('reads %s a require() on Windows writes as a path', (_case, specifier, file) => {
    expect(pathTarget(specifier, 'C:\\app\\lib\\c.cts', true, path.win32)).toEqual({ file, suffix: '' });
  });

  it('reads an import on Windows as a URL', () => {
    expect(pathTarget('./x%20y.ts?v=1', 'C:\\app\\lib\\a.ts', false, path.win32)).toEqual({ file: 'C:\\app\\lib\\x y.ts', suffix: '?v=1' });
    expect(pathTarget('file:///C:/app/lib/b.ts', 'C:\\app\\lib\\a.ts', false, path.win32)).toEqual({ file: 'C:\\app\\lib\\b.ts', suffix: '' });
    expect(pathTarget('FILE:///C:/app/lib/b.ts', 'C:\\app\\lib\\a.ts', false, path.win32)).toEqual({ file: 'C:\\app\\lib\\b.ts', suffix: '' });
  });

  it.each([
    ['a drive letter, which is not a URL scheme to require()', 'C:\\app\\x', true, true],
    ['a backslash path on POSIX, which is a file name there', '.\\x', true, false],
    ['a package name', 'lodash', true, false],
    ['a # import', '#internal/x', false, false],
    ['a Windows path an import cannot take', 'C:\\app\\x', false, false],
  ])('classifies %s', (_case, specifier, requires, expected) => {
    const platform = specifier.startsWith('C:') ? path.win32 : path.posix;
    expect(isPathSpecifier(specifier, requires, platform)).toBe(expected);
  });

  it('reads a require() on POSIX as a path, and leaves a package name alone', () => {
    expect(pathTarget('/app/lib/helper', '/app/tests/a.cts', true, path.posix)).toEqual({ file: '/app/lib/helper', suffix: '' });
    expect(pathTarget('lodash', '/app/tests/a.cts', true, path.posix)).toBeUndefined();
  });
});
