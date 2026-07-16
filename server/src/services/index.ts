import form from './form';
import validation from './validation';
import submission from './submission';
import exportService from './export';
import email from './email';
import webhook from './webhook';
import license from './license';
import analytics from './analytics';
import telemetry from './telemetry';
import premiumJobs from './premium-jobs';
import telegram from './telegram';

export default {
  form,
  validation,
  submission,
  export: exportService,
  email,
  webhook,
  license,
  analytics,
  telemetry,
  'premium-jobs': premiumJobs,
  telegram,
};
