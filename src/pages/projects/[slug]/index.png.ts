import type { APIRoute } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";
import { generateOgImageForProject } from "@utils/generateOgImages";

export async function getStaticPaths() {
  const projects = await getCollection("projects", ({ data }) => !data.draft);

  return projects.map(project => ({
    params: { slug: project.id },
    props: project,
  }));
}

export const GET: APIRoute = async ({ props }) =>
  new Response(
    await generateOgImageForProject(props as CollectionEntry<"projects">),
    {
      headers: { "Content-Type": "image/png" },
    }
  );
