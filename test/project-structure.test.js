import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

describe('US-001: Project Structure', () => {
    it('should have package.json with type: module', async () => {
        const pkg = JSON.parse(await readFile('package.json', 'utf-8'));
        assert.strictEqual(pkg.type, 'module');
    });

    it('should have crawl script pointing to crawl.js', async () => {
        const pkg = JSON.parse(await readFile('package.json', 'utf-8'));
        assert.strictEqual(pkg.scripts?.crawl, 'node crawl.js');
    });

    it('should have .gitignore with content/ directory', async () => {
        const gitignore = await readFile('.gitignore', 'utf-8');
        assert.ok(gitignore.includes('content/'), '.gitignore should include content/');
    });

    it('should have lib/ directory', async () => {
        const libStat = await stat('lib');
        assert.ok(libStat.isDirectory(), 'lib should be a directory');
    });

    it('should have jsconfig.json for type checking', async () => {
        await access('jsconfig.json', constants.F_OK);
    });
});
