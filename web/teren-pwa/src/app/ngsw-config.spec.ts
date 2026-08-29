import ngswConfig from '../../ngsw-config.json';

interface AssetGroup {
  name: string;
  installMode: string;
  updateMode?: string;
  resources: { files?: string[] };
}

/**
 * The dictionaries are the UI text, not an optional extra.
 *
 * An installed PWA opened with no signal fetches nothing: whatever the service worker did not
 * prefetch simply is not there. Leaving `/i18n/*.json` out renders every screen as blank
 * translation keys — the app looks broken exactly when the foreman is furthest from help. This
 * spec guards the config; the built `ngsw.json` is checked at release time.
 */
describe('service worker configuration', () => {
  const groups = (ngswConfig as { assetGroups: AssetGroup[] }).assetGroups;

  it('prefetches the translation dictionaries', () => {
    const files = groups
      .filter((group) => group.installMode === 'prefetch')
      .flatMap((group) => group.resources.files ?? []);
    expect(files).toContain('/i18n/*.json');
  });

  it('prefetches the app shell, so a cold offline start has something to render', () => {
    const files = groups
      .filter((group) => group.installMode === 'prefetch')
      .flatMap((group) => group.resources.files ?? []);
    expect(files).toEqual(expect.arrayContaining(['/index.html', '/*.js', '/*.css']));
  });

  it('re-fetches the dictionaries on update rather than serving a stale language', () => {
    const i18n = groups.find((group) => (group.resources.files ?? []).includes('/i18n/*.json'));
    expect(i18n?.updateMode).toBe('prefetch');
  });
});
