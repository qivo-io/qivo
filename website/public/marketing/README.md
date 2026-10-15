# Qivo website assets

The product screenshots show the fictional Northstar Labs demo scenario, not
customer data. Portraits visible in them were generated for fictional people.

The landscape visible in the composed screenshots is Francesco Ungaro's
Pexels photo 1526713: https://www.pexels.com/photo/1526713/.
The Pexels license permits this composed product and marketing use:
https://www.pexels.com/license/. The standalone photo is not published here.

Manrope is hosted locally under the SIL Open Font License, published beside the
font at `/marketing/fonts/manrope-OFL.txt`.

Manrope source: https://fonts.gstatic.com/s/manrope/v20/xn7gYHE41ni1AdIRggexSg.woff2

Font SHA-256: `a30ddcd349703aff7464c34bef3fffdff405ee50c113440d7c8693c02d210972`.
License source: https://raw.githubusercontent.com/google/fonts/main/ofl/manrope/OFL.txt.

Rubik 700 sets the "Qivo" wordmark. The site uses Google's subset of it that
contains only Q, i, v and o, embedded in the stylesheet as a data URI so the
wordmark never waits for a download. It is used under the SIL Open Font
License, published at `/marketing/fonts/rubik-OFL.txt`.

Rubik source: https://fonts.googleapis.com/css2?family=Rubik:wght@700&text=Qivo,
which served https://fonts.gstatic.com/l/font?kit=iJWZBXyIfDnIV5PNhY1KTN7Z-Yh-4I-1VVc0Du6i5w&skey=cee854e66788286d&v=v31

Font SHA-256: `090a67686cd73ff57767e67f130127d2d15589b8f5c13a8c9e8946e7ce035cad`.
License source: https://raw.githubusercontent.com/google/fonts/main/ofl/rubik/OFL.txt.

The website publishes Manrope under its file name plus the first eight hex
digits of its SHA-256, `/marketing/fonts/manrope-normal-latin.a30ddcd3.woff2`,
and every page preloads it. Browsers cache published fonts for a year and do
not check them again, because a font that is revalidated on every page swaps
in late and the text briefly shows in another font. Changed font bytes must therefore be
published under a new name. The build derives the name from the content, and
a test fails if a published font name does not match its bytes. The license
files keep their names and normal caching.
