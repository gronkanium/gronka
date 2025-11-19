---
layout: default
title: commands
description: complete list of gronka discord bot commands
---

# commands

complete reference for all gronka bot commands.

{%- include commands-list.html -%}

## command details

{%- for command in site.data.commands -%}

  <h2 id="{{ command.name }}">{{ command.name }}</h2>
  {%- include command-card.html command=command -%}
{%- endfor -%}
