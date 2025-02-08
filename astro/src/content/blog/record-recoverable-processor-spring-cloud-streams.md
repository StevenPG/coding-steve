---
author: StevenPG
pubDatetime: 2025-02-07T12:00:00.000Z
title: Spring Cloud Stream's Record Recoverable Processor
slug: spring-cloud-stream-record-recoverable-processor
featured: true
ogImage: /assets/17e73d45-30ad-4daf-a92b-6333eec91b89.png
tags:
  - software
  - spring boot
  - java
  - kafka
description: An example using the new RecordRecoverableProcessor class in Spring Cloud Streams for 
  highly configurable error handling.
---

Overview
- table of contents
- talk about original issues and dead letter queue
- what happens if error occurs in processor
- no need to show the older clunky ways of doing it
- sample expanded version with spring boot version
- show example with regular processor
- explain function and biconsumer
- show full example
- show repeatable biconsumer

# Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, someone doesn't have to do the same digging I had to do.

# What is OAuth2?

OAuth2 is a popular authorization framework that allows users to grant
third-party applications access to their data without revealing their
credentials. It's often used for services like social media logins, API integrations, and more.

### Key Components of OAuth2

- Authorization Server: Issues access tokens to clients after user authorization.
- Resource Server: Protects resources that can only be accessed with valid access tokens.
- Client: The application requesting access to resources.
- User: The person granting or denying access.

[soby-chako]: https://github.com/sobychacko
