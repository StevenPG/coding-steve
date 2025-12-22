---
author: StevenPG
pubDatetime: 2025-12-22T12:00:00.000Z
title: "Part 5: Vibe Coding for Non-Coders"
slug: vibe-coding-for-non-coders-part-5
featured: false
ogImage: /assets/default-og-image.png
tags:
  - substack
description: An introduction to vibe coding, a method for creating software without traditional coding skills.
---

# Caching for Vibe-Coders

## What Exactly is Caching?

Caching is like keeping a copy of something you use frequently in an easy-to-reach place. Instead of going to the original source every time, you grab the copy first. This copy is in a system that responds much faster than the original source.

In software, caching stores data (images, API responses, database results, etc.) in a faster location so you don’t have to fetch it from the slower original source repeatedly.

This Substack is reader-supported. To receive new posts and support my work, consider becoming a free or paid subscriber.

A good example is how a restaurant works. When you give your order to the wait staff, they take the order to the kitchen. Imagine if every time you wanted to check on your order, you had to contact the kitchen. Everything would slow down and the kitchen staff would be distracted. However, the wait staff acts as a cache in our example. They have the little notepad or tablet that has your order on it, and you can easily check on that without bothering the kitchen!

Back to software, there are different places caching happens:

- Browser cache: Your computer remembers things websites showed you

- Server cache: The backend stores frequently-requested data

- CDN cache: Global servers store copies of your content near users

## Why Should I Care?

Caching directly impacts two things that matter for any application:

1. Speed - Users get instant responses instead of waiting for data to load

2. Cost - You reduce server load and database queries, which means lower hosting bills

A slow app loses users. A fast app keeps them engaged. Caching is often the easiest way to make your app noticeably faster without rewriting code.

## When to Use Caching and Why It Is Extremely Important

Cache when you have:

- Static or slowly-changing data (user profiles, product listings, blog posts)

- Expensive operations (API calls, database queries, complex calculations)

- Repeated requests for the same data within a short timeframe

**Real-world example: Cloudflare**

Cloudflare is a CDN (Content Delivery Network) that sits between your users and your server. When someone visits your site, Cloudflare’s servers cache your content at locations worldwide. The next user in the same region gets your content instantly from Cloudflare instead of your server. This reduces your server’s load and makes your site blazingly fast globally.

Without caching, every single request hits your server. With caching, most requests are likely served from cache—your server barely breaks a sweat. This saves you money and resources!

## Cache Example: React App + Server + Database

Here’s a typical setup:

```
User's Browser → Your Server → Database
```

Without caching, every user request queries the database. With caching:

```
User's Browser (cached) → Your Server (cached) → Database
↓
(only refresh every 5 min)
```

**Practical example: Product listing**

```
// Without caching - slow
app.get('/products', async (req, res) => {
const products = await database.query('SELECT * FROM products');
res.json(products);
});

// With caching - fast
let cachedProducts = null;
let cacheTime = 0;

app.get('/products', async (req, res) => {
// Return cached version if it's fresh
if (cachedProducts && Date.now() - cacheTime < 5 * 60 * 1000) {
return res.json(cachedProducts);
}

// Fetch fresh data only if cache expired
cachedProducts = await database.query('SELECT * FROM products');
cacheTime = Date.now();
res.json(cachedProducts);
});
```


The second version serves the majority of requests from memory instantly, hitting the database only once every 5 minutes.

## Examples of Caching

1. Browser caching - Your computer remembers images/styles from websites

2. API response caching - Store API results locally so you don’t call the API again

3. Database query caching - Cache query results in memory

4. Image/file caching - Store media files in fast storage

5. Session caching - Remember user login info without re-querying

## CDN vs Caching

You may see or get recommended to use a CDN vs implementing a cache. These work together but do different things:

Caching = storing data temporarily to avoid re-fetching it

CDN (Content Delivery Network) = a global network of servers that cache and serve your content from locations closest to users

Think of it this way:

- Caching is the strategy (keep copies of things)

- CDN is one way to implement that strategy at global scale

A CDN includes caching, but caching doesn’t require a CDN. You can cache locally on your server or browser.

## Browser Caching

This is the easiest and most impactful for vibe-coded applications.

Your browser automatically caches resources (images, scripts, styles) based on HTTP headers your server sends. The user doesn’t need to install anything—it just works.

This is done using…

## Cache-Control Header

The Cache-Control header tells browsers how long to remember things:

```
// Tell browser: cache this for 1 hour
app.get('/style.css', (req, res) => {
res.set('Cache-Control', 'max-age=3600');
res.send(cssContent);
});

// Tell browser: cache this forever (use for static assets)
app.get('/logo.png', (req, res) => {
res.set('Cache-Control', 'max-age=31536000');
res.send(imageContent);
});

// Tell browser: don't cache (use for dynamic content)
app.get('/current-time', (req, res) => {
res.set('Cache-Control', 'no-cache');
res.json({ time: new Date() });
});
```

The magic: users’ browsers do this automatically. You just set the header once, and millions of repeat visits become instant—without touching your server.

## When Should We Implement a Cache?

Ask yourself:

- Is this data requested frequently? (Yes → cache it)

- Does this data change rarely? (Yes → cache it longer)

- Is fetching this data slow or expensive? (Yes → cache it)

- Do I have extra time before launch? (No → skip it for now)

Implement caching when it solves a real problem, not preemptively.

## Should Vibe-Coded MVPs Use Caching?

**Short answer: Start without it, add it later.**

For your MVP (minimum viable product):

- Focus on building features that work

- Use browser caching headers (free performance boost)

- Skip backend caching until you see performance problems

Once you launch and users arrive:

- Monitor which pages are slow

- Add caching where you see bottlenecks

- Measure the impact (faster = users stay longer)

Caching is easy to add later. Don’t let it slow down your launch.

## Asking the AI What You Should Cache

When you’re building your app, ask your AI assistant:

“I have a [type of data] that [describe when it’s used]. How often does this data change? Should I cache it?”

Good candidates for caching:

- User profile information

- Product/content listings

- Search results

- Images and media

- API responses from external services

Poor candidates:

- Real-time data (stock prices, live notifications)

- User-specific data that changes frequently

- Sensitive information that needs freshness

Start by caching your static assets (images, CSS, JavaScript) using the cache-control header. That alone could cut your server load massively. Then add more sophisticated caching as you identify bottlenecks.

This is an advanced concept in software, but something to be aware of if you’re building applications. Sometimes a vibe-coded application can be extremely expensive or dirt cheap based solely on the clever application of the caching concept!