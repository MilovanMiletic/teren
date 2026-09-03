import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { UpdateBanner } from './ui/update-banner';

/**
 * The shell. Every screen is a route; the chrome each one needs is its own.
 *
 * The **one** exception is the update banner, and it earns its place here rather than on a screen:
 * a service worker announces a new build whenever it finishes downloading one, which is to say on
 * whichever screen the foreman happens to be standing. It is fixed to the foot of the window, it
 * renders nothing while the microphone is live, and it never reloads anything by itself — see
 * `core/update/app-update.service.ts`.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, UpdateBanner],
  template: '<router-outlet /><app-update-banner />',
})
export class App {}
