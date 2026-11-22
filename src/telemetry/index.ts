import * as Sentry from '@sentry/react';
import posthog from 'posthog-js';
import { scrub, scrubStrings } from './scrub';

export function initTelemetry(): void {
  if (import.meta.env.VITE_SENTRY_DSN) {
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: import.meta.env.VITE_SENTRY_ENVIRONMENT,
      sendDefaultPii: false,
      tracesSampleRate: 0.1,
      integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        networkDetailAllowUrls: [],
        networkCaptureBodies: false,
        beforeAddRecordingEvent: event => scrubStrings(event),
      })],
      replaysSessionSampleRate: 0.25,
      replaysOnErrorSampleRate: 0.25,
      beforeSend: event => scrub(event),
      beforeBreadcrumb: breadcrumb => scrub(breadcrumb),
      beforeSendTransaction: event => scrub(event),
    });
  }
  if (import.meta.env.VITE_POSTHOG_KEY) {
    posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
      api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
      autocapture: false,
      capture_pageview: true,
      person_profiles: 'identified_only',
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: true,
      enable_recording_console_log: false,
      capture_performance: false,
      capture_exceptions: false,
      session_recording: {
        compress_events: false,
        maskAllInputs: true,
        maskTextSelector: '*',
        recordHeaders: false,
        recordBody: false,
        maskCapturedNetworkRequestFn: () => null,
      },
      sanitize_properties: properties => scrub(properties, true),
      before_send: event => scrubStrings(event),
      loaded: client => {
        const session = client.get_session_id();
        const key = `telemetry-replay-${session}`;
        try {
          let selected = sessionStorage.getItem(key);
          if (selected === null) {
            selected = Math.random() < 0.25 ? 'yes' : 'no';
            sessionStorage.setItem(key, selected);
          }
          if (selected === 'yes') client.startSessionRecording();
        } catch {
          // Recording stays disabled when session storage is unavailable.
        }
      },
    });
  }
}
