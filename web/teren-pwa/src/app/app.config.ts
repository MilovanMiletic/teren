import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch } from '@angular/common/http';
import localeSrLatn from '@angular/common/locales/sr-Latn';
import {
  ApplicationConfig,
  LOCALE_ID,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { provideTransloco } from '@jsverse/transloco';

import { routes } from './app.routes';
import { AppStatus } from './core/app-status.service';
import { ProjectService } from './core/projects/project.service';
import { RescueService } from './core/rescue.service';
import { AVAILABLE_LANGUAGES, LOCALE_BY_LANGUAGE, activeLanguage } from './i18n';
import { TranslocoHttpLoader } from './transloco-loader';

registerLocaleData(localeSrLatn, LOCALE_BY_LANGUAGE.sr);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    provideTransloco({
      config: {
        availableLangs: [...AVAILABLE_LANGUAGES],
        defaultLang: activeLanguage(),
        fallbackLang: 'en',
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
      },
      loader: TranslocoHttpLoader,
    }),
    // Date and number formatting is fixed at bootstrap; switching language
    // re-renders text immediately but reformats dates only on the next load.
    { provide: LOCALE_ID, useFactory: () => LOCALE_BY_LANGUAGE[activeLanguage()] },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    provideAppInitializer(() => {
      const projects = inject(ProjectService);
      const rescue = inject(RescueService);
      const status = inject(AppStatus);

      rescue.watch();

      // Bootstrap must never be able to fail. A store that will not open (private mode, exhausted
      // quota) or a project list that will not load are conditions the app reports on screen; an
      // uncaught rejection here would abort bootstrap to a blank page, which is the one outcome a
      // foreman on a roof cannot do anything with.
      return Promise.all([
        projects.load().catch(() => undefined),
        // Assembles any recording the phone was interrupted in the middle of, then queues drafts
        // nobody came back to. Exempts whatever entry the current URL is showing.
        rescue.run().catch(() => status.reportStorageFailure()),
      ]).then(() => undefined);
    }),
  ],
};
