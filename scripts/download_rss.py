#!/usr/bin/env python3
"""Download the Letterboxd RSS feed and save cleaned XML.

Fetches the RSS feed, cleans HTML descriptions (removes images, non-renderable
tags), and outputs both raw and cleaned XML files.
"""

import requests
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
import re
from bs4 import BeautifulSoup

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

url = 'https://letterboxd.com/michaellamb/rss/'

script_dir = Path(__file__).parent
base_dir = script_dir.parent
data_dir = base_dir / 'data'
data_dir.mkdir(parents=True, exist_ok=True)


def clean_description(description):
    """Clean description HTML: remove images, non-renderable tags, empty paragraphs."""
    try:
        if description.startswith('<![CDATA[') and description.endswith(']]>'):
            description = description[9:-3]
        if '&lt;' in description:
            from html import unescape
            description = unescape(description)

        soup = BeautifulSoup(description, 'html.parser')

        for img in soup.find_all('img'):
            img.decompose()
        for p in soup.find_all('p'):
            if not p.get_text(strip=True):
                p.decompose()

        allowed_tags = ['p', 'br', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'span', 'div']
        for tag in soup.find_all():
            if tag.name not in allowed_tags:
                tag.replace_with(soup.new_string(tag.get_text()))

        cleaned_html = str(soup).strip()
        return cleaned_html if cleaned_html else '<p>No content available</p>'
    except Exception as e:
        print(f'Error cleaning description: {e}')
        return description


def download_rss():
    try:
        response = requests.get(url)
        response.raise_for_status()

        rss_path = data_dir / 'rss.xml'
        rss_path.write_bytes(response.content)
        print(f'Downloaded RSS feed to {rss_path}')

        tree = ET.fromstring(response.content)
        cleaned_descriptions = {}

        for item in tree.findall('.//item'):
            try:
                desc_elem = item.find('description')
                if desc_elem is not None and desc_elem.text:
                    cleaned = clean_description(desc_elem.text)
                    item_id = item.find('guid').text
                    cleaned_descriptions[item_id] = cleaned
            except Exception as e:
                print(f'Error processing item: {e}')

        # Build cleaned XML
        xml_lines = ['<?xml version="1.0" encoding="utf-8"?>']
        xml_lines.append('<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">')
        xml_lines.append('  <channel>')

        channel = tree.find('channel')
        for child in channel:
            if child.tag == 'item':
                continue
            xml_lines.append(f'    {ET.tostring(child, encoding="unicode")}')

        for item in tree.findall('.//item'):
            item_id = item.find('guid').text
            xml_lines.append('    <item>')
            for child in item:
                if child.tag == 'description':
                    continue
                xml_lines.append(f'      {ET.tostring(child, encoding="unicode")}')
            if item_id in cleaned_descriptions:
                xml_lines.append(f'      <description><![CDATA[{cleaned_descriptions[item_id]}]]></description>')
            else:
                desc = item.find('description').text
                xml_lines.append(f'      <description>{desc}</description>')
            xml_lines.append('    </item>')

        xml_lines.append('  </channel>')
        xml_lines.append('</rss>')

        cleaned_path = data_dir / 'cleaned_rss.xml'
        cleaned_path.write_text('\n'.join(xml_lines), encoding='utf-8')
        print(f'Saved cleaned RSS to {cleaned_path}')

    except requests.RequestException as e:
        print(f'Failed to fetch RSS feed: {e}')
    except ET.ParseError as e:
        print(f'Failed to parse RSS feed: {e}')
    except Exception as e:
        print(f'Unexpected error: {e}')


if __name__ == '__main__':
    download_rss()
