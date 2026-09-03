import { Cog, Shield } from '@strapi/icons';

import { getTranslation } from './utils/getTranslation';
import { PLUGIN_ID } from './pluginId';
import { Initializer } from './components/Initializer';
import { PluginIcon } from './components/PluginIcon';
import { PERMISSIONS } from './permissions';

import './ee'; // side-effect import to prevent tree-shake of ee/ barrel

export default {
  register(app: any) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: PluginIcon,
      intlLabel: {
        id: getTranslation('plugin.name'),
        defaultMessage: 'FormFlow',
      },
      // Only show the menu entry to roles granted at least form-read. The page
      // itself is also wrapped in <Page.Protect> for defense in depth.
      permissions: PERMISSIONS.main,
      // Keep this a `.then()` chain resolving to `{ default }`. With
      // `await` + destructuring on the dynamic import, Rollup rewrites the
      // call site in the host admin's production build into a shim that drops
      // the chunk namespace, and the page crashes on load. See issue #57.
      Component: () => import('./pages/App').then(({ App }) => ({ default: App })),
    });

    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}-settings`,
      icon: Cog,
      intlLabel: {
        id: getTranslation('settings.menu.label'),
        defaultMessage: 'FormFlow Settings',
      },
      permissions: PERMISSIONS.settings.read,
      Component: () =>
        import('./pages/App').then(({ SettingsApp }) => ({ default: SettingsApp })),
    });

    // Settings and Compliance use sibling route mounts rather than descendants
    // of `plugins/${PLUGIN_ID}`. Strapi's sidebar links use prefix matching, so
    // descendant destinations would also leave the main FormFlow icon active.
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}-compliance`,
      icon: Shield,
      intlLabel: {
        id: getTranslation('compliance.menu.label'),
        defaultMessage: 'Compliance',
      },
      permissions: PERMISSIONS.main,
      Component: () =>
        import('./pages/App').then(({ ComplianceApp }) => ({ default: ComplianceApp })),
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });
  },

  async registerTrads({ locales }: { locales: string[] }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = await import(`./translations/${locale}.json`);

          return { data, locale };
        } catch {
          return { data: {}, locale };
        }
      })
    );
  },
};
