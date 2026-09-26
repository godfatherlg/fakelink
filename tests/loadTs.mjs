import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Load a TypeScript module from the plugin sources into plain Node.
 *
 * There is no test runner in the project and no desire to add one: esbuild is
 * already a devDependency, so a module is bundled to CommonJS in memory and
 * evaluated. `obsidian` is stubbed - it only exists inside the app - and every
 * name that could be imported from it resolves to a harmless placeholder class,
 * which is enough because the values under test never call into it.
 */
const stubObsidian = {
    name: 'stub-obsidian',
    setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            // A Proxy would break `new`, so hand out a class for any name.
            contents: 'module.exports = new Proxy({}, { get: () => class Stub {} });',
            loader: 'js',
        }));
    },
};

// Async on purpose: esbuild rejects plugins in the synchronous API, and the
// stub below is a plugin.
export async function loadTs(entryPoint) {
    const result = await build({
        entryPoints: [entryPoint],
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        plugins: [stubObsidian],
        logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const module = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', code)(module, module.exports, require);
    return module.exports;
}
