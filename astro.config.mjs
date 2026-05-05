import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const labelExpressiveCodeCopyButtons = {
  name: 'wraith-copy-button-labels',
  hooks: {
    postprocessRenderedBlock: ({ renderData }) => {
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'element' && node.tagName === 'button' && node.properties?.['data-code']) {
          node.properties.type = 'button';
          node.properties['aria-label'] = 'Copy command';
        }
        if (node.type === 'element' && node.tagName === 'div' && Object.keys(node.properties ?? {}).length === 0) {
          node.properties = { 'aria-hidden': 'true' };
        }
        if (Array.isArray(node.children)) node.children.forEach(visit);
      };
      visit(renderData.blockAst);
    },
  },
};

const patchStaticCopyButtons = {
  name: 'wraith-static-copy-button-labels',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      const root = fileURLToPath(dir);
      const htmlFiles = [];
      const walk = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(path);
          } else if (entry.isFile() && entry.name.endsWith('.html')) {
            htmlFiles.push(path);
          }
        }
      };
      await walk(root);
      await Promise.all(
        htmlFiles.map(async (path) => {
          const html = await readFile(path, 'utf8');
          const patched = html.replaceAll(
            '<button title="Copy to clipboard" data-copied=',
            '<button type="button" aria-label="Copy command" title="Copy to clipboard" data-copied='
          );
          if (patched !== html) await writeFile(path, patched);
        })
      );
    },
  },
};

export default defineConfig({
  site: 'https://wraith.cx',
  integrations: [
    starlight({
      title: 'wraith',
      favicon: '/favicon.svg',
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Installation', slug: 'installation' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Twin Lifecycle', slug: 'twin-lifecycle' },
            { label: 'Streaming', slug: 'streaming' },
            { label: 'Simulation', slug: 'simulation' },
            { label: 'OpenAPI seed mode', slug: 'openapi' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'configuration' },
            { label: 'Changelog', slug: 'changelog' },
          ],
        },
      ],
      customCss: ['./src/styles/custom.css'],
      expressiveCode: {
        plugins: [labelExpressiveCodeCopyButtons],
      },
      head: [
        {
          tag: 'script',
          content: 'document.documentElement.dataset.theme="dark";',
        },
      ],
      disable404Route: false,
      components: {
        Head: './src/components/Head.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        TableOfContents: './src/components/TableOfContents.astro',
      },
    }),
    patchStaticCopyButtons,
  ],
});
