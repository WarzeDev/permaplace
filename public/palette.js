// Shared by the server (validation, OG images) and the browser (rendering).
// Character codes are what is stored in the SQLite chunks - never change them.
// [char, hex (3 digits), name]
export const COLORS = [
  ["a", "800", "Maroon"],
  ["b", "840", "Brown"],
  ["I", "860", "Bronze"],
  ["c", "880", "Olive"],
  ["d", "080", "Green"],
  ["F", "086", "Jade"],
  ["e", "088", "Teal"],
  ["f", "448", "Slate"],
  ["g", "008", "Navy"],
  ["h", "408", "Indigo"],
  ["i", "808", "Purple"],
  ["j", "000", "Black"],
  ["k", "444", "Charcoal"],
  ["l", "F00", "Red"],
  ["m", "F80", "Orange"],
  ["J", "FB0", "Amber"],
  ["n", "FF0", "Yellow"],
  ["o", "0F0", "Lime"],
  ["G", "6EB", "Mint"],
  ["p", "6DE", "Sky"],
  ["q", "88F", "Periwinkle"],
  ["r", "00F", "Blue"],
  ["s", "80F", "Violet"],
  ["t", "F0F", "Magenta"],
  ["u", "FFF", "White"],
  ["v", "888", "Gray"],
  ["w", "F88", "Salmon"],
  ["x", "FB8", "Peach"],
  ["K", "FD8", "Sand"],
  ["y", "FF8", "Lemon"],
  ["z", "8F8", "Light green"],
  ["H", "8FD", "Aquamarine"],
  ["A", "0FF", "Cyan"],
  ["B", "BBF", "Lavender"],
  ["C", "ACE", "Powder blue"],
  ["D", "B8F", "Lilac"],
  ["E", "F8F", "Pink"],
  [",", "CCC", "Silver"],
];

export const EMPTY = ".";
export const CHUNK = 100; // pixels per chunk edge (stored format)
export const BLACK = "j"; // drawn as #222 in dark mode so it stays visible on a black canvas
export const BLACK_DARK_HEX = "222";
export const CHARS = new Set(COLORS.map((c) => c[0]));