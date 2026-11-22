import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Writer's Room",
    short_name: "Writer's Room",
    description: "Talk out ideas anywhere. Your words, filed.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4efe4",
    theme_color: "#f4efe4",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
