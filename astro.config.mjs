import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://wraith.cx',
  integrations: [
    starlight({
      title: 'wraith',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/bobisme/wraith-releases',
        },
      ],
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
      head: [
        {
          tag: 'script',
          content: 'document.documentElement.dataset.theme="dark";',
        },
      ],
      disable404Route: false,
      components: {
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
    }),
  ],
});
