# Application fonts

The application, the operator console and the demo serve their fonts from
their own origin. `src/styles/tokens.css` declares them, and Vite publishes
each file under `/assets/` with a content hash in its name.

Instrument Sans and Geist Mono are the files Google Fonts served the
application for
https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap,
fetched with a Chrome User-Agent on 2026-10-17. Each file is one Unicode
subset of a variable font with a weight axis and no width axis. Instrument
Sans covers weights 400 to 700, and Geist Mono 100 to 900. Every subset Google
served is kept. A browser downloads a subset only when a page shows one of its
characters, and task text and Markdown code can be in any script.

| File | Source | SHA-256 |
| --- | --- | --- |
| `instrument-sans-latin.woff2` | https://fonts.gstatic.com/s/instrumentsans/v4/pxiTypc9vsFDm051Uf6KVwgkfoSxQ0GsQv8ToedPibnr0SZe1Q.woff2 | `2ee17598a98d8a59e4df8152d015bec9ab8e4d5672cc0ab42bef806b568e3971` |
| `instrument-sans-latin-ext.woff2` | https://fonts.gstatic.com/s/instrumentsans/v4/pxiTypc9vsFDm051Uf6KVwgkfoSxQ0GsQv8ToedPibnr0She1YmV.woff2 | `c4fcfea41f2c1cfeea9211fa43679845454a1d0e0d7e95e069c7e73c4ae302d2` |
| `geist-mono-latin.woff2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmg.woff2 | `684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc` |
| `geist-mono-latin-ext.woff2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrkdmgPn.woff2 | `1a189eb997c3e2ece68373e387afaec9e8617424186c4b1ab3cff7c54ba6223b` |
| `geist-mono-cyrillic.woff2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrMdmgPn.woff2 | `4866787fc952dbdbd591d6923d67bc21c2d894b93f34ab69d0cdf25d47bfb2df` |
| `geist-mono-cyrillic-ext.woff2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrodmgPn.woff2 | `cd8800999070b729e1cc0bf7a48da6c3ac096a044251171b9a7574b56d96d4b4` |
| `geist-mono-vietnamese.woff2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrgdmgPn.woff2 | `d39b60889a94a527a7f73c7988a2d6efb6c081614aef683b0b386c02d74c2175` |
| `geist-mono-symbols2.woff2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFg08vz7ehw.woff2 | `5bb66d8319ba1602bb2eb67dce8d79c2b4687be8ce183a0574433e949b3c60ad` |

Both families are used under the SIL Open Font License, in
`instrument-sans-OFL.txt` and `geist-mono-OFL.txt` beside the fonts.
License sources:
https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentsans/OFL.txt
and https://raw.githubusercontent.com/google/fonts/main/ofl/geistmono/OFL.txt.

`rubik-700-qivo.woff2` sets the "Qivo" wordmark under `rubik-OFL.txt`. Its
source is listed in `website/public/marketing/README.md`.
