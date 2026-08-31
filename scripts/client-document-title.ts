/**
 * Projection of the public build title into the two committed web-client
 * documents that carry it as literal text: `apps/web/index.html` and
 * `apps/web/public/manifest.webmanifest`. Both ship the local-build
 * placeholder verbatim, and the Vite build rewrites every occurrence to the
 * selected `DSH_CLIENT_TITLE`. A document that lost its placeholder fails the
 * build instead of shipping a stale name.
 */

/** Placeholder title committed to the index document and the install manifest. */
export const DEFAULT_CLIENT_TITLE = 'DeepMeow'

/** Official public title, whose install-manifest launcher label is abbreviated. */
const OFFICIAL_CLIENT_TITLE = 'DeepSeek Harness'

/** Launcher label used in place of the official title, which is too long for a home-screen icon. */
const OFFICIAL_CLIENT_SHORT_NAME = 'DSH'

/** Install-manifest string members that carry a build title. */
const MANIFEST_TITLE_MEMBERS = ['name', 'short_name', 'description'] as const

/** Escape build-time text before placing it in the HTML title element. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render one JSON object member exactly as the committed manifest formats it. */
function manifestMember(member: string, value: string): string {
  return `${JSON.stringify(member)}: ${JSON.stringify(value)}`
}

/**
 * Replace the placeholder in the index document's title element.
 * @param html - index document carrying the placeholder title element.
 * @param title - selected public build title.
 * @returns the document with an HTML-escaped title element.
 */
export function projectDocumentTitle(html: string, title: string): string {
  const placeholder = `<title>${DEFAULT_CLIENT_TITLE}</title>`
  if (!html.includes(placeholder)) {
    throw new Error(`index document lost its ${JSON.stringify(placeholder)} element`)
  }
  return html.replace(placeholder, () => `<title>${escapeHtmlText(title)}</title>`)
}

/**
 * Replace every placeholder title in the install manifest.
 * `name` and `description` carry the full title; `short_name` carries the
 * launcher label, which is the DSH abbreviation for the official title.
 * @param manifest - install manifest carrying the placeholder members.
 * @param title - selected public build title.
 * @returns the manifest with JSON-encoded titles.
 */
export function projectManifestTitle(manifest: string, title: string): string {
  const shortName = title === OFFICIAL_CLIENT_TITLE ? OFFICIAL_CLIENT_SHORT_NAME : title
  let projected = manifest
  for (const member of MANIFEST_TITLE_MEMBERS) {
    const placeholder = manifestMember(member, DEFAULT_CLIENT_TITLE)
    if (!projected.includes(placeholder)) {
      throw new Error(`install manifest lost its ${JSON.stringify(placeholder)} member`)
    }
    const value = member === 'short_name' ? shortName : title
    projected = projected.replace(placeholder, () => manifestMember(member, value))
  }
  return projected
}
