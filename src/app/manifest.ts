import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NGTManager",
    short_name: "NGTManager",
    description: "Gestione del laboratorio di riparazione",
    start_url: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: "#FFD600",
    icons: [
      {
        src: "/brand/ngt-app-icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/brand/ngt-app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
