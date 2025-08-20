---
author: StevenPG
pubDatetime: 2025-08-00T12:00:00.000Z
title: Building a Website Purely with Vibes
slug: building-webapp-with-vibes
featured: false
ogImage: /assets/17e73d45-30ad-4daf-a92b-6333eec91b89.png
tags:
  - ai
description: I'm usually skeptical of AI-generated content, but I wanted to see if I could build a website purely with vibes. Here's how it went.
---

## Building a Website Purely with Vibes as a Developer

As a software developer, I have at least a dozen active project ideas in my head at any given time, but not nearly enough time to think about, design and implement each one.

One of the oldest is the idea of a website that helps explain how manual transmissions work, in a way that helps people learn to drive them. I used to spend time on reddit helping explain how transmissions work, in a bid to help posters learn how to operate their manual vehicles. A lot of the time, what helped was doing transmission ratio math for them, and explaining exactly what RPM a driver should shift at, for each gear.

You can see the current status of it here: https://stevenpg.github.io/StickShiftMaster

This afternoon, I was talking with my cousin, who over the course of our lifetimes has been ahead of me in what’s popular (much to my embarrassment later), and AI has been no different. He showed me that there are new and free SaaS offerings that provide AI project creation capability, so I figured; what better candidate than this Stickshift site. I’ve tried to create it a few times in the past, but I was never happy with the implementation.

We looked over Base44, Lovable and Replit. Replit seemed to be the most developer oriented (we determined), so I bookmarked the site to try out later.

A few hours pass and I decide to dive in!

I’ve done a fair amount of React in my career, but I’m very backend oriented. I’m not very quick with layouts, so I’m hoping Replit can do the hard work for me!

### Replit

I drafted up a quick few paragraphs about the project. My goal to teach others how to drive stick, how they should be able to input values into a calculator, and other descriptors about the site.

From there, I clicked the the button that re-configured my prompt into a much better, Replit prompt. Here is that prompt:

- React-based educational web application using PrimeReact components that teaches users how to operate manual transmission (stick shift) vehicles through interactive RPM gauge demonstrations and mechanical concept explanations.

  - Core Features:

  - Interactive RPM gauge simulator with real-time calculations using the provided formula: [(Axle Ratio x Vehicle Speed x Transmission Ratio x 336.13) / Tire Diameter]

  - User input fields for all transmission gears (1st through 10th), vehicle speed, axle gear ratio, and tire diameter to calculate engine RPM

  - Step-by-step tutorials explaining clutch operation, gear shifting mechanics, and transmission principles

  - Practice scenarios with real-time feedback showing RPM changes during different driving situations

- Visual References:

- Inspired by driving simulator interfaces and automotive dashboard displays, focusing on clear instrumentation and educational clarity.

- Style Guide:

  - Colors: Primary #FF6B35 (automotive orange), Secondary #004E89 (deep blue), Background #F7F9FC (light grey), Text #1A1D29 (dark navy), Accent #FFD23F (warning yellow), Success #27AE60 (green)

  - Design: Roboto/Open Sans fonts, dashboard-style layout with prominent gauge displays, card-based lesson structure, automotive-inspired UI elements, responsive design with clear visual hierarchy

This looked good to me! I happily accepted the prompt and Replit got to work.

A few minutes later, it gave back a preview that included an entire stubbed out “learning to drive stickshift” educational platform. This was waaaaay out of scope, so I informed the agent that it should be a single page and a single route.

Another 15 minutes or so of prompting for updates and trying to fix an RPM gauge that Replit just could not get correct (seen below), and I was pretty happy with the starting point.

![img.png](../../../public/assets/engine-rpm-gauge.png)

This is the result from Replit, kinda impressive to whip up a React app in that short of time!


However, this is where things get a little less exciting.

### Jetbrains - Junie
I knew that I didn’t want to host this through Vercel or Replit. I need to flex my developer-cred with a spinkle of cheapness, so of course I have to do Github Pages (which is free to host client-facing applications).

On top of that, the project still had a LOT of dead links, fake references and empty buttons.

I was able to export the project from Replit after doing some google searching. Turns out, you simply add .zip to the Replit active URL.

From there, I opened the project in IntelliJ and prepared to start prompting Junie. I figured I might as well stick to using AI for this, taking it as far as I can without any manual coding.

This process took about an hour until I was happy. Here are the highlights of my Junie prompts:

- Remove all of the dead links

- Try to fix the RPM gauge

- make it work locally

- please make it work locally

- make it work with Github pages at least

Herein we find the first issue.

Replit evidently uses server.js and a specific structure to execute these projects. This doesn’t work locally, so I wasn’t able to use the live-server feature that is typically used during this type of development. So I had to do manual builds, but those wouldn’t render either.

I started to review the code, until I realized that I should ask Junie to clear out all of the server components, so that I can make this run on Github Pages.

Multiple requests later, everything still wasn’t working, especially when deployed into Github Pages.

![img.png](../../../public/assets/404.png)

I had to give Junie the Github Pages path for it to format the paths properly.

The router error was also telling. I spent a few more minutes trying to get Junie to fix the issue, until I finally requested it remove “react-router” specifically. From there, everything started linking up!

![img.png](../../../public/assets/linked-up.png)

Takeaways
It’s crazy to think that this all happened over the course of an hour. This definitely would’ve been a one or two day process if I had done it by hand. It would’ve been more had I iterated on the design more than once or twice.

I can understand how some developers don’t like this workflow, because it feels like I’m picking up someone else’s project. But working closely with the AI in Replit, and reviewing it every step of the way has removed a lot of those feelings, and I feel like I just saved a bunch of time, instead of “outsourcing” the work.

There are still some things I couldn’t get Replit OR Junie to remove, specifically the little components that don’t exist. There’s a “practice scenarios” section that doesn’t point to anything, and a few hanging buttons that lead to nowhere.

The RPM gauge is still messed up, and neither AI could make any progress on it.

The goal now is to finalize this by hand and purchase a domain. With Github Pages, I can run this app forever for free, and once it’s finalized and a lot more useful, I can post it online in the same spaces I used to post helpful tips in.

The ability to bootstrap projects with AI, regardless of your viewpoint of AI, is an incredible time-saver for new projects!

[soby-chako]: https://github.com/sobychacko
