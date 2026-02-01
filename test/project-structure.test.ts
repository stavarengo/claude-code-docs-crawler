import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

interface PackageJson {
    type?: string;
    scripts?: { crawl?: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

async function readPackageJson(): Promise<PackageJson> {
    const content = await readFile('package.json', 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isObject(parsed)) {
        throw new Error('Invalid package.json');
    }
    const scripts = parsed.scripts;
    return {
        type: typeof parsed.type === 'string' ? parsed.type : undefined,
        scripts: isObject(scripts) ? {
            crawl: typeof scripts.crawl === 'string' ? scripts.crawl : undefined,
        } : undefined,
    };
}

describe('US-001: Project Structure', () => {
    it('should have package.json with type: module', async () => {
        const pkg = await readPackageJson();
        assert.strictEqual(pkg.type, 'module');
    });

    it('should have crawl script pointing to src/crawl.ts', async () => {
        const pkg = await readPackageJson();
        assert.strictEqual(pkg.scripts?.crawl, 'tsx src/crawl.ts');
    });

    it('should have .gitignore with content/ directory', async () => {
        const gitignore = await readFile('.gitignore', 'utf-8');
        assert.ok(gitignore.includes('content/'), '.gitignore should include content/');
    });

    it('should have src/ directory', async () => {
        const srcStat = await stat('src');
        assert.ok(srcStat.isDirectory(), 'src should be a directory');
    });

    it('should have tsconfig.json for type checking', async () => {
        await access('tsconfig.json', constants.F_OK);
    });
});
