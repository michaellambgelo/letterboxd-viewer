#!/usr/bin/env ruby
# encoding: utf-8
# scripts/generate_og_cards.rb
#
# Renders the 1200x630 link-preview (Open Graph) cards for each page into
# assets/images/og/, using the blog's own card renderer so every
# michaellamb.dev property shares one design:
#
#   ruby scripts/generate_og_cards.rb
#
# Needs ImageMagick and a sibling checkout of michaellambgelo.github.io, which
# holds the renderer (scripts/generate_seo_image.rb), the vendored Inter TTFs
# and the logo. Not run by CI. Re-run by hand when a card's text changes.
#
# Link-preview scrapers cache by image URL, so a changed card needs a new
# filename (e.g. network-2.png) and the og:image tag updated to match.

BLOG = File.expand_path('../../michaellambgelo.github.io', __dir__)
OUT  = File.expand_path('../assets/images/og', __dir__)

CARDS = [
  { file: 'stats.png',   eyebrow: 'LETTERBOXD · STATS',   title: 'Every film I’ve logged, by the numbers' },
  { file: 'rolodex.png', eyebrow: 'LETTERBOXD · ROLODEX', title: 'The people I follow, and their last four films' },
  { file: 'network.png', eyebrow: 'LETTERBOXD · NETWORK', title: 'Who I follow, who follows me, and who’s in JXN Film Club' },
  { file: 'tags.png',    eyebrow: 'LETTERBOXD · TAGS',    title: 'Every film I’ve logged, by where and who I watched it with' },
].freeze

abort "Blog checkout not found at #{BLOG}" unless File.directory?(BLOG)

# The renderer resolves fonts and the logo from REPO_ROOT = Dir.pwd, which it
# reads when the file loads, so load it from inside the blog checkout.
Dir.chdir(BLOG) { require File.join(BLOG, 'scripts', 'generate_seo_image.rb') }
abort 'ImageMagick not found (`magick` or `convert`).' unless convert_available?

# The footer prints SITE_URL; these pages live on the subdomain.
Object.send(:remove_const, :SITE_URL)
SITE_URL = 'letterboxd.michaellamb.dev'

Dir.mkdir(OUT) unless Dir.exist?(OUT)
Dir.chdir(BLOG) do
  CARDS.each do |card|
    path = File.join(OUT, card[:file])
    render_card(path, "assets/images/og/#{card[:file]}",
                title: card[:title], category: card[:eyebrow],
                date_str: '', tone: TONES['dark'])
  end
end
