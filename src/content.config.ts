import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// Blog posts - Markdown files in src/content/blog/
const blog = defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/blog"}),
    schema: z.object({
        title: z.string(),
        description: z.string(),
        pubDate: z.coerce.date(),   // parses "2026-09-14" into a Date
        tags: z.array(z.string()).default([]),
        draft: z.boolean().default(false),
    }),
});

// Projects - Markdown files in src/content/projects/
const projects = defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/projects"}),
    schema: z.object({
        title: z.string(),
        summary: z.string(),
        github: z.string().url().optional(),
        youtube: z.string().url().optional(),
        order: z.number().default(0),
    }),
});

export const collections = { blog, projects };