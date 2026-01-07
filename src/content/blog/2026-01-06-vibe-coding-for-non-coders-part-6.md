---
author: StevenPG
pubDatetime: 2026-01-06T12:00:00.000Z
title: "Part 6: Vibe Coding for Non-Coders"
slug: vibe-coding-for-non-coders-part-6
featured: false
ogImage: /assets/default-og-image.png
tags:
  - substack
description: An introduction to vibe coding, a method for creating software without traditional coding skills.
---

# Message Processing for Vibe-Coders

## What is Message Processing?

Imagine you're running a busy restaurant. When a customer places an order, the waiter doesn't run to the kitchen, stand there while the chef cooks, then run back to serve—that would be incredibly slow. Instead, the waiter writes down the order on a ticket, hangs it on a rail, and moves on to the next customer. The kitchen picks up tickets when ready, prepares the food, and rings a bell when it's done.

That ticket rail is message processing in a nutshell.

In software, message processing (sometimes called "message queues" or "event-driven architecture") is a way for different parts of your application to communicate without waiting for each other. One part says "hey, this thing happened" by putting a message somewhere, and another part picks it up and handles it when it's ready.

## Why Should Vibe-Coders Care?

When you build apps with AI platforms like Lovable, Replit, or even local tools like Claude Code, everything happens "synchronously" by default. That's a fancy word meaning: one thing happens, then the next thing happens, then the next thing.

This works fine until it doesn't. Here's when it breaks down:

### The Waiting Problem

Let's say you're building a social app. A user posts a photo. Your app needs to:

1. Save the photo to storage
2. Generate a thumbnail
3. Scan for inappropriate content
4. Notify all followers
5. Update the user's activity feed
6. Send a push notification

If you do all of this in order, the user clicks "Post" and... waits. And waits. Maybe 10-30 seconds. Most users will assume the app crashed and close it.

With message processing, you:

1. Save the photo and immediately tell the user "Posted!"
2. Put a message in a queue: "Hey, new photo uploaded, do all that other stuff"
3. Background workers pick up that message and handle everything else

The user sees instant feedback. The work still happens—just not in their face.

### Real-World Scenarios Where You Need This

**Sending emails**: When a user signs up, you want to send a welcome email. But email services are slow and unreliable. If you wait for the email to send before showing the user "Account created!", they might wait 5 seconds. With message processing, you queue the email and move on.

**Processing uploads**: User uploads a video. Converting it to different formats takes minutes. You don't make them stare at a spinning wheel—you queue the processing and notify them when it's done.

**Webhooks and integrations**: You connect your app to Stripe. When someone pays, Stripe sends a webhook (a message) to your server. You need to handle it quickly and reliably, even if your database is slow.

**Real-time notifications**: User A comments on User B's post. User B should see a notification appear. This is event-driven—something happened, and others need to know about it.

## The Enterprise Trap: Why Kafka and RabbitMQ Aren't For You

If you search for "message queue" or "message processing," you'll immediately find mentions of Apache Kafka and RabbitMQ. Let me save you some pain: these are not for people not comfortable with those specific tools.

### Why Kafka Is Overkill

Kafka was built by LinkedIn to handle billions of messages per day across thousands of servers. It requires:

- Running and maintaining Kafka servers (or paying for expensive managed services)
- Understanding partitions, consumer groups, offsets, and topics
- Writing significant boilerplate code just to send a simple message
- A dedicated team to keep it running smoothly

Using Kafka for your vibe-coded app is like hiring a fleet of 18-wheelers to deliver a pizza. Could it work? Sure. But it's wildly impractical.

### Why RabbitMQ Is Still Too Complex

RabbitMQ is simpler than Kafka, but you still need to:

- Deploy and manage a RabbitMQ server
- Understand exchanges, bindings, and queues
- Handle connection pooling and reconnection logic
- Monitor and maintain the infrastructure

For an app with dozens or even thousands of users, this complexity isn't worth it. You'd spend more time maintaining the queue than building features.

## The Friendly Alternatives

Here's the good news: there are tools designed for developers (and vibe-coders) who want message processing without the headache. These tools handle all the infrastructure, give you simple APIs, and have generous free tiers.

When searching these out, I looked for tools that remind me of Supabase, which is a AI friendly database service.

### Inngest

Inngest is built specifically for event-driven applications and is incredibly ai-friendly.

**What it does**: You define functions that run when events happen. Inngest handles queuing, retries, scheduling, and monitoring.

**Why it's great for vibe-coders**:
- No infrastructure to manage—it's fully serverless
- Dead-simple API: you just send an event, and your function runs
- Built-in retries if something fails
- Great dashboard to see what's happening
- Works with any framework (Next.js, Express, etc.)

Here's what sending a welcome email looks like with Inngest:

```typescript
// Define what happens when a user signs up
export const sendWelcomeEmail = inngest.createFunction(
  { id: "send-welcome-email" },
  { event: "user/signed-up" },
  async ({ event }) => {
    await sendEmail({
      to: event.data.email,
      subject: "Welcome!",
      body: "Thanks for signing up!"
    });
  }
);

// Somewhere in your signup code, just send the event
await inngest.send({
  name: "user/signed-up",
  data: { email: user.email, name: user.name }
});
```

That's it. The user sees "Account created!" instantly. The email sends in the background. If the email service is down, Inngest automatically retries.

### Trigger.dev

Trigger.dev is another excellent choice, focused on background jobs and workflows.

**What it does**: Lets you run long-running tasks in the background with a simple API.

**Why it's great for vibe-coders**:
- Background jobs that just work
- No timeouts—tasks can run for hours if needed
- Built-in logging and monitoring
- Serverless, so you don't manage infrastructure
- Free tier is generous for side projects

Here's what processing an uploaded image looks like:

```typescript
export const processImage = task({
  id: "process-image",
  run: async (payload: { imageUrl: string; userId: string }) => {
    // Generate thumbnail
    const thumbnail = await generateThumbnail(payload.imageUrl);

    // Scan for content
    await scanForInappropriateContent(payload.imageUrl);

    // Update database
    await db.images.update({
      where: { url: payload.imageUrl },
      data: { thumbnail, processed: true }
    });

    // Notify user
    await notifyUser(payload.userId, "Your image is ready!");
  }
});

// In your upload handler
await processImage.trigger({
  imageUrl: uploadedUrl,
  userId: currentUser.id
});
// User sees "Upload complete!" immediately
```

### Quick Comparison

Both are excellent choices. If your app is heavily event-driven (things happen, other things react), lean toward Inngest. If you have lots of background processing (uploads, reports, data crunching), lean toward Trigger.dev.

## When to Ask Your AI for Message Processing

Here are the scenarios where you should prompt your AI to implement message processing:

**Prompt for message processing when**:
- Anything involves sending emails or SMS
- Users upload files that need processing
- You're integrating with external APIs that might be slow
- You need real-time notifications between users
- Any operation takes more than 1-2 seconds
- You're handling webhooks from services like Stripe or GitHub

**You probably don't need it when**:
- Simple CRUD operations (create, read, update, delete)
- Operations that complete in milliseconds
- You have very few users and can tolerate some slowness

## Example Prompts for Your AI

Here are specific prompts you can use:

**For email sending**:
```
I want to send a welcome email when users sign up, but I don't
want the signup to wait for the email to send. Use Inngest to
queue the email as a background task. Show me how to set up
the event and the function that handles it.
```

**For file processing**:
```
When a user uploads an image, I need to generate thumbnails and
scan for inappropriate content. This takes too long to do during
the upload. Use Trigger.dev to process the image in the background
and notify the user when it's done.
```

**For webhooks**:
```
I'm integrating with Stripe. When a payment succeeds, Stripe sends
a webhook to my server. I need to handle this reliably—even if my
database is slow. Set up an Inngest function to process Stripe
webhooks with automatic retries.
```

**For notifications**:
```
When User A comments on User B's post, User B should receive a
notification. Use event-driven architecture with Inngest so the
comment saves instantly and the notification is sent in the background.
```

## Red Flags to Watch For

When reviewing AI-generated code, watch out for these signs that message processing might be missing:

1. **Long `await` chains**: If you see a bunch of async operations happening one after another during a user action, that's a bottleneck waiting to happen

2. **Email/SMS sent inline**: If signup or checkout code directly calls an email service, that's fragile and slow

3. **File processing in request handlers**: If image/video processing happens before returning a response to the user, they're waiting too long

4. **No error handling for external services**: If an external API fails and your whole operation fails, you need queuing with retries

5. **Comments like "TODO: make this async"**: The AI knows it should be async—ask it to actually implement it!

Use the dashboards available with these tools to monitor and troubleshoot your app.

## The Mental Model

Here's the simple way to think about it:

**Without message processing**: Everything happens in a single line. If any step is slow or fails, everything stops.

```
User clicks → Save → Email → Thumbnail → Notify → "Done!"
                ↓
         (user waits for all of this)
```

**With message processing**: User sees success immediately. Everything else happens in parallel, in the background.

```
User clicks → Save → "Done!"
                ↓
         Queue message
                ↓
    ┌─────────┼─────────┐
    ↓         ↓         ↓
  Email   Thumbnail   Notify
    ↓         ↓         ↓
 (retries) (retries) (retries)
```

The second approach is more resilient, faster for users, and scales better.

## Summary

Message processing is how professional applications stay fast and reliable even when doing complex things. The concept is simple—put a note on the rail instead of blocking the kitchen—but the traditional tools (Kafka, RabbitMQ) are enterprise-grade and overkill for most projects.

As a vibe-coder, you have access to modern tools like Inngest and Trigger.dev that give you all the benefits without the complexity. They're serverless, have generous free tiers, and integrate easily with whatever stack your AI generates.

When you're building features that involve sending messages, processing files, handling webhooks, or any operation that takes more than a second—ask your AI to implement it with background processing. Your users will thank you with faster experiences, and your app will handle growth without falling over.

The key prompts to remember:
- "Queue this as a background task"
- "Send this event and handle it asynchronously"
- "Don't make the user wait for this operation"
- "Use Inngest/Trigger.dev for this"

That's message processing for vibe-coders. It's one of those concepts that separates apps that feel professional from apps that feel janky—and now you know how to ask for it.
