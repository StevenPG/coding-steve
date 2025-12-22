---
author: StevenPG
pubDatetime: 2025-11-18T12:00:00.000Z
title: "Part 4: Vibe Coding for Non-Coders"
slug: vibe-coding-for-non-coders-part-4
featured: false
ogImage: /assets/default-og-image.png
tags:
  - substack
description: An introduction to vibe coding, a method for creating software without traditional coding skills.
---

https://stevenpg1.substack.com/p/part-4-vibe-coding-for-non-coders


What is Pagination and Why Should I Care
Building applications through new AI platforms is exciting, and while they do an amazing job of building elegant user interfaces and integrating with external applications like Spotify or Supabase, without the careful oversight of a software developer, there are pitfalls that applications with a lot of users can run into.

It All Depends
Let me start with a thought experiment. Imagine you’re building a social media feed—like Twitter or Instagram. Your AI has created this beautiful, scrollable interface where posts just appear as users scroll down.

Now, imagine your app gets popular. Really popular. You’ve got 10,000 users, and each user has posted maybe 5 times. That’s 50,000 posts total in your database.

What happens when a new user opens your app for the first time?

Without pagination, your application would try to download all 50,000 posts at once. Not just the 10 posts that fit on their screen, but all of them. Every single post, every image, every comment, every like count—all 50,000 of them.

Let’s talk about what this means in the real world.

The Content Download Problem
Think about the last time you scrolled through social media. You probably saw a few posts with images or videos. Those files are big. A single photo might be 2-5 megabytes. A video could be 50 megabytes or more.

If your app tried to download all 50,000 posts at startup, and even just half of them had images, you’re looking at potentially downloading gigabytes of data before the user even sees a single post.

Now think about someone on a mobile connection. Maybe they’re on 4G, or worse, spotty WiFi. That download isn’t happening in seconds—it could take minutes. Or it might fail halfway through and crash the entire app.

Even if the download somehow completes, the user is staring at a blank screen the whole time, wondering if the app is broken.

Memory and Network Bandwidth
Every piece of data your application downloads has to live somewhere—in the user’s phone or computer memory.

Your browser or app can only hold so much data in active memory before it starts slowing down or crashing. If you load all 50,000 posts into memory at once, you’re asking the device to juggle an enormous amount of information. Older phones, or devices with limited RAM, might just give up and crash.

On the network side, imagine if you had 100,000 concurrent users all trying to download 50,000 posts at the same time. Your server would be crushed. The bandwidth bill alone could bankrupt a startup.

Pagination solves all of this elegantly.

What is Pagination, Actually?
Pagination is the practice of breaking data into smaller, manageable chunks—pages. Instead of asking for all 50,000 posts, you ask for the first 10. When the user scrolls to the bottom, you ask for the next 10. And so on.

It’s like the difference between a library handing you every single book at once versus handing you books one shelf at a time as you ask for them.

The benefits are immediate:

- **Faster initial load**: The user sees content in milliseconds instead of minutes

- **Lower memory usage**: The device only holds the posts currently visible (or soon to be visible)

- **Reduced server strain**: You’re sending smaller chunks of data to many users instead of everything to one user

- **Better user experience**: The app feels snappy and responsive

Why Doesn’t the AI Do This For Me?
This is where we hit an interesting wall with AI-generated code.

When you ask an AI to “create a task management app” or “build a social feed,” the AI has no way of knowing if you’ll have 10 items or 10 million items. It doesn’t know if your users will be on fast corporate internet or slow mobile networks. It builds a solution that works for the demo—and demos typically have small amounts of data.

So the AI generates code that loads all available data at once. It’s simple, it works for testing, and it showcases the feature without complexity.

But here’s the thing: as your application grows, this becomes a problem that’s increasingly expensive to fix retroactively. It’s much cheaper to build pagination in from the start.

An Example: The AI’s Default Approach
Let’s say you prompt an AI like this:

Create a React component that displays all tasks from a database.
Users should be able to scroll through their tasks.
The AI might generate something like:

function TaskList() {
const [tasks, setTasks] = useState([]);
useEffect(() => {
// Load ALL tasks from the database
fetchAllTasks().then(setTasks);
}, []);
return (
<div>
{tasks.map(task => (
<TaskCard key={task.id} task={task} />
))}
</div>
);
}
This loads everything at once. It’s clean, it’s simple, and it will work great until you have 100,000 tasks.

Adding Pagination: A Better Prompt
Now let’s ask the AI to do better. Here’s a much more specific prompt:

Create a React component that displays tasks from a database
using pagination. Load 20 tasks per page. When the user scrolls
to the bottom of the list, automatically load the next page of
tasks. Show a loading indicator while fetching.
Use infinite scroll, not page numbers. The user should never
need to click “next page”—new tasks should just appear as they scroll.
The AI will now generate something much more sophisticated:

function TaskList() {
const [tasks, setTasks] = useState([]);
const [page, setPage] = useState(0);
const [isLoading, setIsLoading] = useState(false);
const [hasMore, setHasMore] = useState(true);
const loadMoreTasks = useCallback(async () => {
if (isLoading || !hasMore) return;
setIsLoading(true);
const newTasks = await fetchTasks(page, 20);
if (newTasks.length < 20) {
setHasMore(false);
}
setTasks(prev => [...prev, ...newTasks]);
setPage(prev => prev + 1);
setIsLoading(false);
}, [page, isLoading, hasMore]);
useEffect(() => {
loadMoreTasks();
}, []);

// ... rest of component with scroll detection

}
Notice the difference? Now we’re loading in chunks. We track which page we’re on. We know when we’ve run out of data. We handle loading states gracefully.

The Red Flags to Watch For
When you’re reviewing AI-generated code, here are signs that pagination might be missing:

1. **No page or offset variable**: If you don’t see anything tracking “which batch am I on,” pagination probably isn’t happening

2. **A single `fetchAllData()` call**: If the AI is loading everything in one go, that’s a red flag

3. **No loading indicator for scrolling**: Good pagination shows the user something is happening when more data loads

4. **Comments about “works for demos”**: If the AI mentions this is simplified or works for small datasets, ask it to add pagination

Summary
Pagination isn’t just a “nice to have”—it’s fundamental to building applications that scale. A beautifully designed interface that crashes under real-world usage isn’t beautiful at all.

The good news is that once you know what to look for, you can ask your AI to implement it from the start. And unlike some technical concepts, pagination is straightforward enough that the AI will get it right if you’re specific about what you want.

The next post will cover another critical concept that AI often overlooks: **Caching for Vibe-Coders**. Caching is about making your application faster by remembering things it’s already done—and it solves problems that pagination alone can’t address.