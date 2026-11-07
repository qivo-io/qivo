/* The bounds of MCP access's two lists, Personal access tokens
   (panels/settings/PersonalTokens.tsx) and Connected apps
   (panels/ConnectedApps.tsx), which read the server 25 rows a batch.
   Tests lower them and set them back. */

/** The most personal tokens the token list gathers with Load more, 80
    batches; past it the list asks for a search. No design-size figure
    covers a person's tokens and the owner expects one or a few, so this
    bounds the rows the page holds, about 2,000 rows of a few hundred bytes,
    not the tokens a person may keep, which every search still reaches.
    Tests lower it. */
export const TOKEN_LIST = { most: 2000 }

/** The most connected apps the Connected apps list gathers with Load
    more, 80 batches; past it the list asks for a search. As with
    TOKEN_LIST, it bounds the rows the page holds, not the connections a
    login may keep. Tests lower it. */
export const APP_LIST = { most: 2000 }
