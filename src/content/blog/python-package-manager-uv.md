---
author: StevenPG
pubDatetime: 2025-06-10T12:00:00.000Z
title: UV - The Modern Python Package Manager
slug: python-package-manager-uv
featured: false
# TODO replace ogImage
ogImage: https://user-images.githubusercontent.com/53733092/215771435-25408246-2309-4f8b-a781-1f3d93bdf0ec.png
tags:
  - software
  - python
  - tools
description: Exploring uv, the ultra-fast Python package manager and resolver that's changing how we manage dependencies.
---

## Brief

Python package management has long been a source of frustration for many developers. Slow resolution times, dependency conflicts, and inconsistent environments are common complaints. This post introduces uv, a modern alternative that addresses these pain points with impressive speed and reliability.

## What is uv?

[uv](https://github.com/astral-sh/uv) is an extremely fast Python package manager and resolver developed by [Astral](https://astral.sh/). Written in Rust, it serves as a drop-in replacement for pip, pip-tools, and virtualenv, offering significant performance improvements and enhanced features.

The name "uv" doesn't stand for anything specific - it's simply a short, memorable name that's easy to type, much like the tool itself aims to be simple and efficient to use.

### Why uv Over Other Package Managers?

#### 1. Blazing Fast Performance

The most immediately noticeable benefit of uv is its speed. Compared to traditional tools like pip:

- Installation is typically 10-100x faster
- Dependency resolution can be up to 1000x faster
- Creating virtual environments happens in milliseconds

This performance difference becomes increasingly significant as projects grow in complexity. What might take minutes with pip often takes just seconds with uv.

```bash
# Time installing a package with dependencies
> time uv add pandas
Using CPython 3.13.1 interpreter at: /opt/homebrew/opt/python@3.13/bin/python3.13
Creating virtual environment at: .venv
Resolved 7 packages in 3ms
Installed 6 packages in 34ms
 + numpy==2.3.0
 + pandas==2.3.0
 + python-dateutil==2.9.0.post0
 + pytz==2025.2
 + six==1.17.0
 + tzdata==2025.2
uv add pandas  0.02s user 0.05s system 107% cpu 0.066 total
```

#### 2. Consistent Environments

uv ensures deterministic builds by default. It generates lockfiles that precisely capture your environment, making it easier to reproduce builds across different systems and at different times.

#### 3. Improved Dependency Resolution

The resolver in uv is more sophisticated than pip's, handling complex dependency graphs more effectively and providing clearer error messages when conflicts occur.

#### 4. Unified Toolchain

Instead of juggling multiple tools (pip, pip-tools, virtualenv), uv provides a single, cohesive interface for all package management tasks.

#### 5. Native Support for Modern Python Features

uv fully supports modern Python packaging standards like PEP 621 (project metadata in pyproject.toml) and PEP 660 (editable installs).

## Common Tasks with uv

Let's look at how to perform common package management tasks using uv.

### Installation

First, you'll need to install uv itself:

```bash
# Using pip
pip install uv

# Using Homebrew on macOS
brew install uv

# Using cargo (Rust package manager)
cargo install uv
```

### Creating and Managing Virtual Environments

Creating a virtual environment is straightforward:

```bash
# Create a new virtual environment in the .venv directory
uv venv

# Activate the virtual environment
# On Unix/macOS
source .venv/bin/activate
# On Windows
.venv\Scripts\activate
```

### Installing Packages

Installing packages works similarly to pip but much faster:

```bash
# Install a single package
uv pip install requests

# Install from requirements.txt
uv pip install -r requirements.txt

# Install development dependencies
uv pip install -e ".[dev]"
```

### Managing Dependencies with Lockfiles

One of uv's strengths is its built-in support for lockfiles:

```bash
# Generate a lockfile from requirements.txt
uv pip compile requirements.txt -o requirements.lock

# Install from lockfile
uv pip sync requirements.lock
```

### Upgrading Packages

Upgrading packages is simple:

```bash
# Upgrade a specific package
uv pip install --upgrade requests

# Upgrade all packages
uv pip install --upgrade-all
```

## Configuration File

uv supports configuration through the standard `pyproject.toml` file, making it compatible with modern Python project structures. Here's an example configuration:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "my-awesome-project"
version = "0.1.0"
description = "A project using uv for dependency management"
requires-python = ">=3.8"
dependencies = [
    "requests>=2.28.0",
    "pandas>=1.5.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0.0",
    "black>=23.0.0",
    "mypy>=1.0.0",
]

[tool.uv]
# uv-specific configurations
exclude = ["tests"]
```

You can also use a separate `requirements.txt` file if you prefer:

```
# requirements.txt
requests>=2.28.0
pandas>=1.5.0
```

## Real-World Example: Setting Up a Data Science Project

Let's see how uv simplifies setting up a data science environment:

```bash
# Create and activate a virtual environment
uv venv
source .venv/bin/activate  # On Unix/macOS

# Create a requirements.txt file
cat > requirements.txt << EOF
numpy>=1.24.0
pandas>=2.0.0
matplotlib>=3.7.0
scikit-learn>=1.2.0
jupyter>=1.0.0
EOF

# Generate a lockfile
uv pip compile requirements.txt -o requirements.lock

# Install dependencies
uv pip sync requirements.lock

# Ready to work!
jupyter notebook
```

This entire process takes just seconds with uv, compared to potentially minutes with traditional tools.

## Summary

uv represents a significant advancement in Python package management. Its speed, reliability, and modern feature set make it an excellent choice for both new and existing Python projects.

By replacing multiple tools with a single, cohesive solution, uv simplifies the development workflow while providing better performance and more consistent environments. Whether you're working on a small script or a large-scale application, uv can help you manage dependencies more effectively.

As the Python ecosystem continues to evolve, tools like uv demonstrate how thoughtful engineering can solve long-standing pain points in the development process. If you're tired of waiting for pip to resolve dependencies or dealing with environment inconsistencies, give uv a try - you might be surprised by how much it improves your workflow.
