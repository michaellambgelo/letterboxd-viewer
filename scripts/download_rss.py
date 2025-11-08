import requests
import os
from datetime import datetime
import xml.etree.ElementTree as ET
from PIL import Image
import sys
from pathlib import Path
import shutil
import re
from bs4 import BeautifulSoup

# Set stdout encoding to UTF-8
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# URL of the RSS feed
url = 'https://letterboxd.com/michaellamb/rss/'

# Set up paths using pathlib for cross-platform compatibility
script_dir = Path(__file__).parent
base_dir = script_dir.parent
data_dir = base_dir / 'data'
images_dir = base_dir / 'assets' / 'images'
thumbs_dir = images_dir / 'thumbs'
fulls_dir = images_dir / 'fulls'

# Ensure directories exist
data_dir.mkdir(parents=True, exist_ok=True)
images_dir.mkdir(parents=True, exist_ok=True)
thumbs_dir.mkdir(parents=True, exist_ok=True)
fulls_dir.mkdir(parents=True, exist_ok=True)

# Function to download images
def download_image(url, path):
    try:
        response = requests.get(url)
        response.raise_for_status()
        
        # Ensure path is a Path object
        path = Path(path)
        
        # Write the image data
        path.write_bytes(response.content)
        print(f'Successfully downloaded image to {path}')
        return True
    except Exception as e:
        print(f'Failed to download image {url}: {e}')
        return False

# Function to sanitize filenames
def sanitize_filename(title):
    # Remove "contains spoilers" from the title
    title = title.replace('(contains spoilers)', '').strip()
    title = title.replace('contains spoilers', '').strip()
    
    # Remove special characters and convert to lowercase
    sanitized = title.lower()
    # Replace spaces with hyphens
    sanitized = sanitized.replace(' ', '-')
    # Remove any other special characters except hyphens and alphanumeric
    sanitized = ''.join(c for c in sanitized if c.isalnum() or c == '-')
    # Replace multiple hyphens with single hyphen
    while '--' in sanitized:
        sanitized = sanitized.replace('--', '-')
    # Remove leading/trailing hyphens
    sanitized = sanitized.strip('-')
    # Remove any ½ characters that might appear in ratings
    sanitized = sanitized.replace('½', '')
    return sanitized

# Function to create a thumbnail from a full-size image
def create_thumbnail(full_image_path, thumb_image_path, size=(600, 900)):  # 2:3 aspect ratio with higher resolution
    try:
        # Ensure paths are Path objects
        full_image_path = Path(full_image_path)
        thumb_image_path = Path(thumb_image_path)
        
        # Open the image
        with Image.open(full_image_path) as img:
            # Convert to RGB if necessary
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            
            # Calculate aspect ratio
            aspect = img.width / img.height
            target_aspect = 2/3  # Movie poster ratio
            
            # Determine crop box
            if aspect > target_aspect:  # Image is too wide
                new_width = int(img.height * target_aspect)
                left = (img.width - new_width) // 2
                crop_box = (left, 0, left + new_width, img.height)
            else:  # Image is too tall
                new_height = int(img.width / target_aspect)
                top = (img.height - new_height) // 2
                crop_box = (0, top, img.width, top + new_height)
            
            # Crop and resize
            img = img.crop(crop_box)
            img = img.resize(size, Image.Resampling.LANCZOS)
            
            # Save with high quality
            img.save(thumb_image_path, 'JPEG', quality=95)
        
        print(f'Created thumbnail: {thumb_image_path}')
        return True
    except Exception as e:
        print(f'Failed to create thumbnail: {e}')
        return False

def clean_image_directories():
    """Clean the fulls and thumbs image directories before downloading new images."""
    try:
        # Define paths
        fulls_dir = images_dir / 'fulls'
        thumb_dir = images_dir / 'thumbs'
        
        # Remove and recreate full directory
        if fulls_dir.exists():
            shutil.rmtree(fulls_dir)
        fulls_dir.mkdir(exist_ok=True)
        
        # Remove and recreate thumbs directory
        if thumb_dir.exists():
            shutil.rmtree(thumb_dir)
        thumb_dir.mkdir(exist_ok=True)
        
        print("Successfully cleaned image directories")
    except Exception as e:
        print(f"Error cleaning image directories: {e}")

# Function to clean description content
def clean_description(description):
    """
    Clean the description content by:
    1. Removing <img> tags
    2. Removing non-renderable HTML
    3. Removing empty paragraph tags
    4. Trimming whitespace
    5. Ensuring cleaned content appears below article content
    
    Args:
        description (str): The HTML description content from the RSS feed
        
    Returns:
        str: Cleaned HTML description
    """
    try:
        # If the description is CDATA wrapped, extract the content
        if description.startswith('<![CDATA[') and description.endswith(']]>'):
            description = description[9:-3]
        
        # Decode HTML entities if they exist
        if '&lt;' in description:
            from html import unescape
            description = unescape(description)
        
        # Use BeautifulSoup to parse the HTML
        soup = BeautifulSoup(description, 'html.parser')
        
        # Find and remove all img tags
        for img in soup.find_all('img'):
            img.decompose()
        
        # Remove empty paragraph tags
        for p in soup.find_all('p'):
            if not p.get_text(strip=True):  # If paragraph is empty or contains only whitespace
                p.decompose()
        
        # Keep only renderable HTML elements (p, br, a, ul, ol, li, etc.)
        # This is a whitelist approach to ensure only safe elements remain
        allowed_tags = ['p', 'br', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'span', 'div']
        for tag in soup.find_all():
            if tag.name not in allowed_tags:
                # Replace with its text content
                tag.replace_with(soup.new_string(tag.get_text()))
        
        # Get the cleaned HTML as a string and trim whitespace
        cleaned_html = str(soup).strip()
        
        # If the result is completely empty, return an empty paragraph
        if not cleaned_html or cleaned_html == "":
            return "<p>No content available</p>"
            
        return cleaned_html
    except Exception as e:
        print(f"Error cleaning description: {e}")
        return description  # Return original if cleaning fails

# Fetch the RSS feed
def download_rss():
    try:
        response = requests.get(url)
        response.raise_for_status()
        
        # Save the RSS feed
        rss_path = data_dir / 'rss.xml'
        with open(rss_path, 'wb') as f:
            f.write(response.content)
        print(f'Successfully downloaded RSS feed to {rss_path}')
        
        # Parse the XML
        tree = ET.fromstring(response.content)
        
        # Create a dictionary to store cleaned descriptions
        cleaned_descriptions = {}
        
        # Find all items
        for item in tree.findall('.//item'):
            try:
                # Extract description and title
                description_elem = item.find('description')
                description = description_elem.text
                title = item.find('title').text
                
                # Find image URL using more robust parsing
                img_match = re.search(r'src="([^"]+)"', description)
                if img_match:
                    img_url = img_match.group(1)
                    
                    # Get base filename
                    base_filename = sanitize_filename(title)
                    
                    # Check if this is a list entry (contains "letterboxd-list-")
                    if "letterboxd-list-" in img_url:
                        # For list entries, we'll keep the original image URL
                        img_url = img_url
                    else:
                        # For movie entries, get the highest resolution possible
                        # Replace common resolution patterns with higher resolution
                        img_url = img_url.replace('-0-150-', '-0-2000-')  # Increase from 150 to 2000
                        img_url = img_url.replace('-0-230-', '-0-2000-')  # Increase from 230 to 2000
                        img_url = img_url.replace('-0-500-', '-0-2000-')  # Increase from 500 to 2000
                        img_url = img_url.replace('-0-1000-', '-0-2000-')  # Increase from 1000 to 2000
                    
                    # Define paths for full and thumb images
                    base_filename = base_filename.rstrip('-')  # Remove any trailing hyphens
                    full_path = fulls_dir / f'{base_filename}_full.jpg'
                    thumb_path = thumbs_dir / f'{base_filename}_thumb.jpg'
                    
                    # Download and create thumbnail only if they don't exist
                    if not full_path.exists():
                        if download_image(img_url, str(full_path)):
                            # Only create thumbnail if download succeeded
                            if not thumb_path.exists():
                                create_thumbnail(str(full_path), str(thumb_path))
                    elif not thumb_path.exists():
                        # If full exists but thumb doesn't, recreate thumb
                        create_thumbnail(str(full_path), str(thumb_path))
                
                # Clean the description content
                cleaned_description = clean_description(description)
                
                # Store the cleaned description with the item's ID
                item_id = item.find('guid').text
                cleaned_descriptions[item_id] = cleaned_description
                    
            except Exception as e:
                print(f'Error processing item: {e}')
                continue
        
        # Save the cleaned RSS data to a new file
        cleaned_rss_path = data_dir / 'cleaned_rss.xml'
        
        # Create a new XML string manually to ensure proper formatting
        xml_lines = ['<?xml version="1.0" encoding="utf-8"?>']
        xml_lines.append('<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">')
        xml_lines.append('  <channel>')
        
        # Add channel metadata
        channel = tree.find('channel')
        for child in channel:
            if child.tag == 'item':
                continue
            
            # Convert element to string
            child_str = ET.tostring(child, encoding='unicode')
            xml_lines.append(f"    {child_str}")
        
        # Add items with cleaned descriptions
        for item in tree.findall('.//item'):
            item_id = item.find('guid').text
            
            # Start item tag
            xml_lines.append('    <item>')
            
            # Add all child elements except description
            for child in item:
                if child.tag == 'description':
                    continue
                
                # Convert element to string
                child_str = ET.tostring(child, encoding='unicode')
                xml_lines.append(f"      {child_str}")
            
            # Add description with CDATA if we have a cleaned version
            if item_id in cleaned_descriptions:
                cleaned_desc = cleaned_descriptions[item_id]
                xml_lines.append(f'      <description><![CDATA[{cleaned_desc}]]></description>')
            else:
                # Fallback to original description
                desc = item.find('description').text
                xml_lines.append(f'      <description>{desc}</description>')
            
            # End item tag
            xml_lines.append('    </item>')
        
        # Close channel and rss tags
        xml_lines.append('  </channel>')
        xml_lines.append('</rss>')
        
        # Write the XML to file
        with open(cleaned_rss_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(xml_lines))
        
        print(f'Successfully saved cleaned RSS feed to {cleaned_rss_path}')
                
    except requests.RequestException as e:
        print(f'Failed to fetch RSS feed: {e}')
    except ET.ParseError as e:
        print(f'Failed to parse RSS feed: {e}')
    except Exception as e:
        print(f'Unexpected error: {e}')

if __name__ == '__main__':
    download_rss()
