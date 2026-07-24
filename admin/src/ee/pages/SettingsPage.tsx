/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { Layouts, Page } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { getTranslation } from '../../utils/getTranslation';
import { TelegramConnectionsSettings } from '../components/TelegramConnectionsSettings';

export const SettingsPage = () => {
  const { formatMessage } = useIntl();
  const title = formatMessage({ id: getTranslation('settings.global.title'), defaultMessage: 'FormFlow Settings' });

  return (
    <Page.Main>
      <Page.Title>{title}</Page.Title>
      <Layouts.Header
        title={title}
        subtitle={formatMessage({
          id: getTranslation('settings.global.subtitle'),
          defaultMessage: 'Manage shared integrations used by your forms.',
        })}
      />
      <Layouts.Content>
        <TelegramConnectionsSettings />
      </Layouts.Content>
    </Page.Main>
  );
};
