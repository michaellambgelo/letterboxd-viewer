import requests
import os
from datetime import datetime
import xml.etree.ElementTree as ET
from PIL import Image
import sys
from pathlib import Path
import shutil

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

# Fetch the RSS feed
def download_rss():
    try:
        # Clean image directories first
        clean_image_directories()
        
        response = requests.get(url)
        response.raise_for_status()
        
        # Save the RSS feed
        rss_path = data_dir / 'rss.xml'
        with open(rss_path, 'wb') as f:
            f.write(response.content)
        print(f'Successfully downloaded RSS feed to {rss_path}')
        
        # Parse the XML
        tree = ET.fromstring(response.content)
        
        # Find all items
        for item in tree.findall('.//item'):
            try:
                # Extract description and title
                description = item.find('description').text
                title = item.find('title').text
                
                # Find image URL using more robust parsing
                import re
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
                    
                    # Download and create thumbnail if needed
                    if not full_path.exists() or not thumb_path.exists():
                        if download_image(img_url, str(full_path)):
                            create_thumbnail(str(full_path), str(thumb_path))
                    
            except Exception as e:
                print(f'Error processing item: {e}')
                continue
                
    except requests.RequestException as e:
        print(f'Failed to fetch RSS feed: {e}')
    except ET.ParseError as e:
        print(f'Failed to parse RSS feed: {e}')
    except Exception as e:
        print(f'Unexpected error: {e}')

if __name__ == '__main__':
    download_rss()
