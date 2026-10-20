// Record shapes Semble itself writes, copied from cosmik-network/semble at
// commit b70bade, src/modules/atproto/infrastructure/:
//   publishers/ATProtoCardPublisher.ts       -> mappers/CardMapper.ts
//   publishers/ATProtoConnectionPublisher.ts -> mappers/ConnectionMapper.ts
//   publishers/ATProtoCollectionPublisher.ts -> mappers/CollectionMapper.ts, mappers/CollectionLinkMapper.ts
// and the lexicons in lexicons/card.json, connection.json, collection.json,
// collectionLink.json (each declares "key": "tid").
//
// What the mappers set, for the cases anote produces (no originalCard, no
// provenance, no via card, no collaborators, metadata with a title only):
//   card URL:   $type, type "URL", content {$type card#urlContent, url, metadata {$type card#urlMetadata, title}},
//               createdAt. No top-level url: CardMapper adds `url` only when the type is not URL.
//   card NOTE:  $type, type "NOTE", content {$type card#noteContent, text}, url (the parent card's url),
//               parentCard {uri, cid}, createdAt.
//   connection: $type, source, target, connectionType, note (left out when there is none), createdAt, updatedAt.
//   collection: $type, name, description (left out when there is none), accessType, collaborators
//               (always an array; [] for a closed collection with none), createdAt, updatedAt.
//   collectionLink: $type, collection {uri, cid}, card {uri, cid}, addedBy, addedAt, createdAt.
// Timestamps (createdAt, updatedAt, addedAt) are set at write time; the dry run
// leaves them out, so they are listed separately here.
// Values below are invented.

export const SEMBLE_SHAPES = {
  urlCard: {
    $type: "network.cosmik.card",
    type: "URL",
    content: {
      $type: "network.cosmik.card#urlContent",
      url: "https://example.org/page",
      metadata: { $type: "network.cosmik.card#urlMetadata", title: "A page" },
    },
  },
  noteCard: {
    $type: "network.cosmik.card",
    type: "NOTE",
    content: { $type: "network.cosmik.card#noteContent", text: "Some text." },
    url: "https://example.org/page",
    parentCard: { uri: "at://did:plc:abcdefghijklmnopqrstuvwx/network.cosmik.card/3kaaaaaaaaaa2", cid: "bafyexample" },
  },
  connection: {
    $type: "network.cosmik.connection",
    source: "https://example.org/a",
    target: "https://example.org/b",
    connectionType: "RELATED",
    note: "why",
  },
  collection: {
    $type: "network.cosmik.collection",
    name: "A collection",
    description: "About it.",
    accessType: "CLOSED",
    collaborators: [],
  },
  collectionLink: {
    $type: "network.cosmik.collectionLink",
    collection: { uri: "at://did:plc:abcdefghijklmnopqrstuvwx/network.cosmik.collection/3kaaaaaaaaaa3", cid: "bafyexample" },
    card: { uri: "at://did:plc:abcdefghijklmnopqrstuvwx/network.cosmik.card/3kaaaaaaaaaa2", cid: "bafyexample" },
    addedBy: "did:plc:abcdefghijklmnopqrstuvwx",
  },
} as const;

/** Timestamps each mapper sets at write time (not part of the dry-run value). */
export const SEMBLE_TIMESTAMPS = {
  urlCard: ["createdAt"],
  noteCard: ["createdAt"],
  connection: ["createdAt", "updatedAt"],
  collection: ["createdAt", "updatedAt"],
  collectionLink: ["addedAt", "createdAt"],
} as const;
