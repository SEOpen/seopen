/** Short labels for DataForSEO SERP item types. Unknown types fall back to a cleaned-up type name. */
const LABELS: Record<string, string> = {
  ai_overview: "AI Overview",
  featured_snippet: "Snippet",
  people_also_ask: "People also ask",
  people_also_search: "Also search",
  related_searches: "Related",
  images: "Images",
  video: "Video",
  short_videos: "Shorts",
  top_stories: "News",
  local_pack: "Local",
  map: "Map",
  knowledge_graph: "Knowledge",
  shopping: "Shopping",
  popular_products: "Products",
  paid: "Ads",
  twitter: "X posts",
  discussions_and_forums: "Forums",
  perspectives: "Perspectives",
  carousel: "Carousel",
  answer_box: "Answer",
  app: "Apps",
  google_reviews: "Reviews",
  find_results_on: "Find on",
  things_to_know: "Things to know",
  explore_brands: "Brands",
  top_sights: "Sights",
  scholarly_articles: "Scholar",
  questions_and_answers: "Q&A",
};

export function featureLabel(type: string): string {
  return LABELS[type] ?? type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
