export type ChannelId = "overallTop10" | "mtv80s" | "viva90s";

export interface TrackInput {
  id: string;
  label: string;
  input: string;
}

export interface ChannelDef {
  id: ChannelId;
  label: string;
  tracks: TrackInput[];
}

export const channels: Record<ChannelId, ChannelDef> = {
  overallTop10: {
    id: "overallTop10",
    label: "Overall Top 10",
    tracks: [
      {
        id: "daft-punk-get-lucky",
        label: "Daft Punk - Get Lucky",
        input: "https://www.youtube.com/watch?v=5NV6Rdv1a3I",
      },
      {
        id: "a-ha-take-on-me",
        label: "a-ha - Take On Me",
        input: "https://www.youtube.com/watch?v=djV11Xbc914",
      },
      {
        id: "weeknd-blinding-lights",
        label: "The Weeknd - Blinding Lights",
        input: "https://www.youtube.com/watch?v=4NRXx6U8ABQ",
      },
      {
        id: "nirvana-teen-spirit",
        label: "Nirvana - Smells Like Teen Spirit",
        input: "https://www.youtube.com/watch?v=hTWKbfoikeg",
      },
      {
        id: "toto-africa",
        label: "Toto - Africa",
        input: "https://www.youtube.com/watch?v=FTQbiNvZqaY",
      },
      {
        id: "mj-billie-jean",
        label: "Michael Jackson - Billie Jean",
        input: "https://www.youtube.com/watch?v=Zi_XLOBDo_Y",
      },
      {
        id: "queen-bohemian-rhapsody",
        label: "Queen - Bohemian Rhapsody",
        input: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
      },
      {
        id: "coldplay-viva-la-vida",
        label: "Coldplay - Viva La Vida",
        input: "https://www.youtube.com/watch?v=dvgZkm1xWPE",
      },
      {
        id: "outkast-hey-ya",
        label: "Outkast - Hey Ya!",
        input: "https://www.youtube.com/watch?v=PWgvGjAhvIw",
      },
      {
        id: "white-stripes-seven-nation-army",
        label: "The White Stripes - Seven Nation Army",
        input: "https://www.youtube.com/watch?v=0J2QdDbelmY",
      },
    ],
  },
  mtv80s: {
    id: "mtv80s",
    label: "MTV 80s",
    tracks: [],
  },
  viva90s: {
    id: "viva90s",
    label: "VIVA 90s",
    tracks: [],
  },
};
