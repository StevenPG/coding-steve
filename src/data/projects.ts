export interface Project {
  name: string;
  url: string;
  description: string;
  tags: string[];
  image: string;
}

export const projects: Project[] = [
  {
    name: "AutoSteven",
    url: "https://autosteven.com/",
    description:
      "A transmission calculating site for comparing gear ratios, RPM ranges, and final drive configurations across different vehicles and setups.",
    tags: ["Web App"],
    image: "/assets/projects/autosteven.png",
  },
  {
    name: "Visual Finances",
    url: "https://visualfinances.com/",
    description:
      "A personal finance visualization tool for tracking and understanding your financial data through interactive charts and dashboards.",
    tags: ["Web App"],
    image: "/assets/projects/visualfinances.png",
  },
  {
    name: "Elden Ring 3D Map",
    url: "https://eldenring3dmap.stevenpg.com/",
    description:
      "An interactive 3D map of the Lands Between built with CesiumJS, rendering the Elden Ring overworld as a navigable 3D tileset with 170+ annotated Sites of Grace.",
    tags: ["Web App", "3D", "Gaming"],
    image: "/assets/projects/eldenring3dmap.png",
  },
];
