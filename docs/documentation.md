# Publishing documentation

The public guide lives in `docs/guide/`. Each topic has one Markdown source
file. The qivo.io website publishes these files at `/docs/` from an exact
commit of this repository; this repository does not contain the website
renderer. Keep user-facing content
there. Technical implementation details belong in [design-spec.md](design-spec.md),
[rest-api.md](rest-api.md) and [mcp.md](mcp.md).

## Create a page

1. Add a Markdown file under `docs/guide/`, such as `planning-basics.md`.
   Write the body without a top-level heading. The page title comes from the
   metadata. Start subsections with `##`.
2. Add a record to `docs/guide/pages.json` with `file`, `slug`, `title`, `order`
   and `description`. Use a unique positive integer for `order`; it determines
   the sidebar and previous/next navigation. The description appears in search
   metadata and on the documentation overview.
3. Choose a lowercase, hyphen-separated `slug`, such as `planning-basics`.
   It publishes at `/docs/planning-basics/`. Keep the slug unchanged after
   publication, even if you rename the page title, a subsection heading or
   the source file.

The manifest's `overview` record configures `/docs/`, whose introductory text
lives in `overview.md`. Keep all guide pages registered in the manifest.

## Link to a page or subsection

Use descriptive link text and a relative Markdown source path. The publisher
converts it to the page's public URL.

```markdown
Read [The Roadmap](./the-roadmap.md).
See [Scheduling by hand](./the-roadmap.md#scheduling-by-hand).
Return to the [documentation overview](./overview.md).
```

Heading IDs use
lowercase ASCII letters and numbers, with punctuation replaced by hyphens,
and are limited to 60 characters. If you rename a published subsection, retain
its previous anchor in the page's `aliases` metadata. Each key is the current
canonical heading ID, and its array contains the old IDs that must still
work. Keep earlier aliases when a heading changes again, moving them under
the new canonical ID.

```json
"aliases": {
  "archiving": ["archiving-done-work-leaves-the-room-on-its-own"]
}
```

## Add an image

Store images beside the content, normally in `docs/guide/images/`. Use a
relative path from the Markdown file and descriptive alternative text that
conveys what the image shows.

```markdown
![Roadmap showing scheduled tasks](./images/roadmap.webp)

*The Roadmap groups scheduled tasks by project and week.*
```

The standalone emphasized paragraph after an image is the optional visible
caption. Include it only when it adds information beyond the alternative
text. Standard Markdown image titles are not captions. Images fit the reading
column and retain their proportions without being enlarged beyond their
natural width. Keep images inside `docs/guide/`; the website copies only
images that pages reference. Keep screenshots free of credentials and
private customer data.

## Preview and validate

Markdown is rendered with markdown-it. Raw HTML is disabled, and unsafe link
schemes remain blocked. Use Markdown for images, links, lists, tables and code.
Any Markdown preview shows the content; the published styling comes from the
website.

Run `node scripts/docs-contract.mjs` for a quick check; `npm run build` and the
test suite run it too. It validates `pages.json`, page file names and slugs,
relative page links and subsection anchors, local images, top-level headings
and the `https://qivo.io/docs/` links in the agent guides in `public/`. Page
files are flat lowercase `.md` names in `docs/guide/`, because the website
fetches only the listed files and the images they reference.

After a change to `docs/guide/` or the agent guides reaches `main`, CI asks the
website to rebuild from the latest `main` commit. A guide the website cannot render fails
its build, and qivo.io keeps serving the previous version.
