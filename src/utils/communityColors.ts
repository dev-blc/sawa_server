const COMMUNITY_PALETTE = [
  '#2E98B8', // Ocean Blue
  '#CF3CA4', // Rose Pink
  '#FF9F43', // Amber Orange
  '#1DD1A1', // Teal Green
  '#54A0FF', // Sky Blue
  '#5F27CD', // Pure Purple
  '#FF6B6B', // Coral Red
  '#48DBFB', // Cyan
  '#FF9FF3', // Soft Pink
  '#00D2D3', // Jade Green
  '#F368E0', // Fuchsia
  '#10AC84', // Dark Teal
];

/**
 * Deterministically pick a color from the premium palette based on the couple's string ID.
 * This ensures they always have the same color in every group chat.
 */
export const getCoupleCommunityColor = (coupleId: string): string => {
  if (!coupleId) return COMMUNITY_PALETTE[0];
  
  // Simple hash function for the coupleId string
  let hash = 0;
  for (let i = 0; i < coupleId.length; i++) {
    hash = coupleId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  const index = Math.abs(hash) % COMMUNITY_PALETTE.length;
  return COMMUNITY_PALETTE[index];
};
