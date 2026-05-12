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
];
