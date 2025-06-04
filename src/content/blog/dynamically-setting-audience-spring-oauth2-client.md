---
author: StevenPG
pubDatetime: 2025-06-02T12:00:00.000Z
title: Dynamically setting audience for using Spring OAuth2 Client
slug: spring-oauth2-client-dynamic-audience
featured: false
draft: true

ogImage: https://i.imgur.com/4ICZldG.jpeg
tags:
  - software
  - spring boot
  - java
  - oauth
description: An article walking through a demo of dynamically setting a query parameter using spring-oauth2-client.
---

# Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, someone doesn't have to do the same digging I had to do.

# What is OAuth2?

OAuth2 is a popular authorization framework that allows users to grant
third-party applications access to their data without revealing their
credentials. It's often used for services like social media logins, API integrations, and more.

Tokens used in the OAuth2 process have required and optional claims. These claims are simple fields that are validated by the receiver of the token as defined in
https://datatracker.ietf.org/doc/html/rfc7519. One of these claims is the "aud" claim, or the audience claim.

The "aud" (audience) claim identifies the recipients that the JWT is intended for and principal that intends to process the JWT must identify itself with a value in the audience claim; otherwise, the JWT must be rejected. The "aud" value is typically an array of case-sensitive strings, each containing a StringOrURI value, though it can also be a single case-sensitive string when there is only one audience. The interpretation of audience values is generally application-specific, and the use of this claim is optional. This is all for defense against "replay attacks", where a token is re-used to call a different target once it's stolen from the initial request.

## Why do I care?

In most systems, these audience claims are set by the OAuth2 provider. For example, if you have a client configured for your application that calls server-a,
the oauth2 server might set every user of that client to automatically set the audience to `"aud": "server-a". This means a client like Spring's oauth2-client
has no reason to care about the audience on the token.

However, there is an uncommon scenario where a federated set of systems may need to dynamically set the audience claim. This is usually done by allowing some
sort of query_parameter on the token request. For example; providing an `intended_audience=my-target-server` query parameter. This would inform the oauth server
to set the audience claim to `"aud": "my-target-server"`.

## Spring Security - Component Model

The main goal of this article is to have a single source of information for setting up custom Client Credentials Provider in Spring Security. The example in this post will be dynamically setting the "aud" claim based on the target host.

TODO - diagram of the pieces

### The Classes at Play

#### Class Name

Description

```java
code
```



TODO

- lay out diagram of classes with descriptions in diagram
- lay out individual classes
- link to public Github with example, add in readme of how to set up keycloak

[github]: https://github.com
