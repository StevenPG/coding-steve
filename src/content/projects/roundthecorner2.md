---
title: RoundTheCorner2
description: An Android app that watches your location in the background and sends an SMS, Slack, or Discord message when you arrive within, or leave beyond, a chosen distance of a saved place.
url: https://github.com/StevenPG/RoundTheCorner2
image: /assets/projects/roundthecorner2.jpg
tags:
  - Android
  - Kotlin
featured: true
order: 7
---

An Android app that watches your location in the background and sends a message when you arrive within, or leave beyond, a chosen distance of a saved place. Save the places you care about, pick who to tell (an SMS contact, a Slack webhook, or a Discord webhook), set a distance, and RoundTheCorner2 sends the message for you, like "Almost home! About 2 mi away."

It's written in Kotlin with Jetpack Compose and Material 3, using Hilt for dependency injection, Room for storage, and a multi-module Gradle build. Places are picked on a MapLibre map with OpenStreetMap tiles. Monitoring runs in a battery-aware foreground service that uses no GPS while you're far from any place, and only tightens up as you get close.

Signed APKs are published from version tags. Grab the latest from the [v0.1.0 release](https://github.com/StevenPG/RoundTheCorner2/releases/tag/v0.1.0), or browse the source on [GitHub](https://github.com/StevenPG/RoundTheCorner2).
