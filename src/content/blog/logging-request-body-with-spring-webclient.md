---
author: StevenPG
pubDatetime: 2024-03-05T12:00:00.000Z
title: Logging Request Body with Spring WebClient
slug: request-body-with-spring-webclient
featured: true

ogImage: https://i.imgur.com/4ICZldG.jpeg
tags:
  - software
  - spring boot
description: An article describing the latest way to log spring web client requests and responses using Logbook.
---

## Previously!

Logging should be one of the easiest thing a programming language or framework provides its developers. It's the first line of defense when trying to debug or keep track of what's going on in an application.

In a [previous blog post on my dev.to account](https://dev.to/stevenpg/logging-with-spring-webclient-2j6o), I wrote up a simple document with a straightforward way of logging using Spring's WebClient.

I was frustrated that I couldn't find any full examples, so (being the change I wanted to see in the world) I wrote it up myself!

That's resulted in a very very small, but non-zero amount of traffic to that article.

![Image of page view statistics, showing 22k visitors since 2020](/assets/3GzdjxY.png)

While that would normally be something I'm happy about, the methodology in my old article is outdated and poorly recommended.

There is a better option than messing around with the WebClient's internal HttpClient, and it is called...

## Logbook

For years now, and especially since Spring Boot 3 arrived on the scene, there is a logging library that can handle just about everything and I use it in every Spring application. Big or small.

I'm talking of course, about [Zalando - Logbook](https://github.com/zalando/logbook)

Here's an example of what you get out of the box with Logbook, using ONLY the addition of the Logbook dependency. No special bean configurations needed!

There's a [section in the README that explains how to add the starter](https://github.com/zalando/logbook?tab=readme-ov-file#spring-boot-starter), but I'll summarize and add a bit about the bom here:

Using gradle, we can use the logbook-bom to align the versions of the logbook dependencies.

    // Logging
    implementation platform("org.zalando:logbook-bom:${logbookVersion}")
    implementation "org.zalando:logbook-spring-boot-starter"
    implementation "org.zalando:logbook-core"
    implementation "org.zalando:logbook-netty"

  With this simple setup, we get full Spring WebClient integration, with clean request and response logging on every invocation of WebClient.

  That's not all, there's a ton of modules the logbook supports dynamically. It's all laid out in the README!

  As long as you have the `logbook-spring-boot-starter`, you'll get a Logbook object for free by the spring autoconfiguration and there's no configuration necessary.

  In keeping with this short and sweet post, I'll include the configuration that ends up being added into every single application I've built or worked on.

    logbook:
      obfuscate:
        headers:
          - Authorization
        parameters:
          - none
      exclude:
        - /actuator/**
      format.style: json

  This formats the logs into JSON (easily consumable by any logging or monitoring tool that supports json logs) and changes the Authorization header into `XXX` in the logs.

  With this, it's trivial to get your spring boot application logging at a production-capable level.

## Outro

If you're coming from that previous page, I highly recommend simply using Logbook. If you're in an environment where dependencies are limited, the methods laid out in that post are still valid and functional. But in a production environment, Logbook is going to provide the best bang for your buck for setting up simple no-nonsense logging.
