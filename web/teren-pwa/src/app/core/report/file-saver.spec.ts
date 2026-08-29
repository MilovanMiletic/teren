import { TestBed } from '@angular/core/testing';

import { FileSaver, OBJECT_URL_LIFETIME_MS } from './file-saver';

/**
 * Handing a fetched blob to the browser.
 *
 * jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL`, which is convenient
 * rather than awkward: stubbing both is the only way to assert the thing that actually matters
 * here — that every URL minted is handed back. An object URL pins the whole PDF, so one leaked
 * per download turns "he checked six days" into tens of megabytes held for the life of the tab.
 */
describe('FileSaver', () => {
  let saver: FileSaver;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.fn().mockReturnValue('blob:teren/report-1');
    revokeObjectURL = vi.fn();
    // Assigned onto the real `URL` rather than replacing it: `new URL(...)` is used all over
    // Angular's own code, and a stub object in its place breaks the test bed rather than the
    // subject.
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    TestBed.configureTestingModule({});
    saver = TestBed.inject(FileSaver);
  });

  afterEach(() => {
    // jsdom implements neither, so putting them back means taking them away again.
    delete (URL as Partial<typeof URL>).createObjectURL;
    delete (URL as Partial<typeof URL>).revokeObjectURL;
    vi.useRealTimers();
  });

  function pdf(): Blob {
    return new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' });
  }

  it('clicks a download link for the blob and takes it back out of the document', () => {
    const clicked: HTMLAnchorElement[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        // Captured mid-click: by the time `save` returns the anchor is gone from the document,
        // and what matters is what it looked like at the moment the browser was asked to act.
        clicked.push(this);
        expect(this.isConnected).toBe(true);
      });

    saver.save(pdf(), 'Teren - izveštaj - 29.08.2026.pdf');

    expect(click).toHaveBeenCalledTimes(1);
    expect(clicked[0].getAttribute('href')).toBe('blob:teren/report-1');
    // The `download` attribute is what makes this a saved file rather than a navigation, and it
    // carries the server's own Serbian name.
    expect(clicked[0].download).toBe('Teren - izveštaj - 29.08.2026.pdf');
    // Nothing left behind in the DOM.
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('revokes the object URL, but not before the browser has had a chance to read it', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    saver.save(pdf(), 'izvestaj.pdf');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Revoking synchronously is the other failure: Safari hands the blob to its PDF viewer well
    // after the click returns, and a URL pulled out from under it produces an empty viewer.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(OBJECT_URL_LIFETIME_MS);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:teren/report-1');
  });

  it('still revokes when the click itself throws', () => {
    // A URL minted and then orphaned by a throw is the same leak, minus the download.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('the browser refused');
    });

    expect(() => saver.save(pdf(), 'izvestaj.pdf')).toThrow('the browser refused');

    vi.advanceTimersByTime(OBJECT_URL_LIFETIME_MS);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:teren/report-1');
  });
});
