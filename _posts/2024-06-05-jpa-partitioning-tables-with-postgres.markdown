---
layout: post
title:  "JPA Partitioning Tables with Progress"
toc: true
date:   2024-06-05 12:00:00 -0500
categories: 
  - software
  - spring boot
  - postgres
---

# Partitioning Databases with JPA

I'm writing this post after doing some research into this topic and finding 
a ton of articles written about partitioning, but nobody ever has ALL of the information
needed to recreate the example they're providing.

So in this article, I want to provide everything needed to understand
exactly how powerful this functionality is and how anyone can roll this into
their project.

First and foremost, what exactly is partitioning and why do we want to partition.

Imagine we have a database that keeps track of cars that have driven
over a certain highway. As time goes on, our database is going to get larger and larger.

When we query our database for certain data, we may have to scan the entire table
which will take longer and longer. The way to get around this is to cut down our
table into smaller tables, thus; partitioning!

For example, we can partition our database by time so that we can limit the
size of our table. (It's not the best example, but it'll do!)

## Setting up our test project

Setting up our project using: https://start.spring.io/

![img.png](img.png)

These two dependencies are all we need to get our demo going!

## Setting up our database

To get easy access to a database that we can use to test, we're going to run
`docker-compose -d up` on the following file:

    version: '3.7'
    services:
        pgAdmin:
            platform: linux/amd64
            image: dpage/pgadmin4:latest
            ports: [ '9001:80' ]
            environment: [ PGADMIN_DEFAULT_EMAIL=postgres, PGADMIN_DEFAULT_PASSWORD=password ]
            restart: on-failure
            depends_on:
            - postgresql
        postgresql:
            platform: linux/amd64
            image: postgis/postgis:16-master
            ports: [ '5432:5432' ]
            environment: [ POSTGRES_PASSWORD=password, POSTGRES_DB=postgres ]
            restart: on-failure
            command:
              - "postgres"
              - "-c"
              - "log_statement=all"

This config works on an M1 Pro Macbook, but it should work
on most machines that can run Docker.

## Configure Our Database
- manually run sql query

## Our JPA Configuration
- write entities by examples

## What are our queries actually doing?
- log the queries
- run explains on the queries
- show inserts are spread apart in partitions