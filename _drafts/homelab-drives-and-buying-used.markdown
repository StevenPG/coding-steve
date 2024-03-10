---
layout: post
title:  "Homelab Drives & Buying Used"
date:   2024-03-10 12:00:00 -0500
categories: 
  - hardware
---

use output from smartmon on shadow

query command for blocks:
- sudo lsblk -f

smartmon command to get stats:
- sudo smartctl --all /dev/sda > output.txt

Two homelab servers
Old gaming media center server:
  - 240GB boot drive power on hours, 3203 
  - (look up when purchased for reference, look up when new computer was built)
Plex server

Seagate 2TB Aged:
  - power on hours 125
  - power on hours 23081 (summarize into days running)

History of Jade old gaming PC
(look up date Jade's new PC was built)

Rainbow set up 1.5 years ago

data drives ages: (5 years is 43830)
  - sda: WD Blue SA510 2.5 500GB - 1 hr on, glitched SSD
  - sdb: 18080 - Toshiba 3.5" DT01ACA... Desktop HD 1TB
    - 2.06 years
  - sdc: 11364 - WDC WD20EFZX-68AWUN0 2TB
    - 1.29 years
  - sdd: 31876 - Seagate Momentus XT (AF) HDD hybrid from old gaming laptop 750GB
    - 3.63 years
  - sde: 8871 - Western Digital Blue 6TB 5400 RPM
    - 1.01 years
  - sdf: 18794 - Seagate Samsung SpinPoint M8 1TB 5400 RPM
    - 2.14 years


You’ll find this post in your `_posts` directory. Go ahead and edit it and re-build the site to see your changes. You can rebuild the site in many different ways, but the most common way is to run `jekyll serve`, which launches a web server and auto-regenerates your site when a file is updated.

Jekyll requires blog post files to be named according to the following format:

`YEAR-MONTH-DAY-title.MARKUP`

Where `YEAR` is a four-digit number, `MONTH` and `DAY` are both two-digit numbers, and `MARKUP` is the file extension representing the format used in the file. After that, include the necessary front matter. Take a look at the source for this post to get an idea about how it works.

Jekyll also offers powerful support for code snippets:

{% highlight ruby %}
def print_hi(name)
  puts "Hi, #{name}"
end
print_hi('Tom')
#=> prints 'Hi, Tom' to STDOUT.
{% endhighlight %}

Check out the [Jekyll docs][jekyll-docs] for more info on how to get the most out of Jekyll. File all bugs/feature requests at [Jekyll’s GitHub repo][jekyll-gh]. If you have questions, you can ask them on [Jekyll Talk][jekyll-talk].

[jekyll-docs]: https://jekyllrb.com/docs/home
[jekyll-gh]:   https://github.com/jekyll/jekyll
[jekyll-talk]: https://talk.jekyllrb.com/
