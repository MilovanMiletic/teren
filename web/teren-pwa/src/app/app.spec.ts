import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('creates the shell', () => {
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });

  /**
   * The update card is the one piece of chrome the shell owns.
   *
   * It has to be here rather than on a screen: a service worker announces a finished download at a
   * moment nobody chose, on whichever screen the foreman is standing. Putting it on Home would
   * mean a foreman who lives on the capture screen never hears about a new build at all — which is
   * exactly the state the app shipped in until now.
   */
  it('carries the update banner, on every screen there is', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('app-update-banner'),
    ).not.toBeNull();
  });
});
