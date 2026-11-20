# Przeglądarka schematów

Przeglądarka schematów elektrycznych w PDF (eTAP/wPDF, SEE Electrical). Działa w przeglądarce, bez serwera — plik PDF jest przetwarzany lokalnie.

## Funkcje
- Kliknięcie odnośnika między potencjałami przenosi na stronę docelową i obramowuje właściwy potencjał; gdy nie ma dopasowania, zaznacza kolumnę u góry i pokazuje żółty komunikat.
- Pasek informacji: tekst odnośnika, nazwa przewodu obok odnośnika, numer diagramu źródłowego.
- Wybór strony i diagramu, wyszukiwarka tekstu, dopasowanie do szerokości/wysokości, przewijanie stron kółkiem, swipe na telefonie.
- **Porównywanie wersji** schematów (nakładka, obok siebie, miganie, lista zmienionych stron, opis dodanych/usuniętych tekstów).
- **Notatki** (tekst i ołówek) zapisywane poza PDF-em; „Zapis auto” do pliku `<nazwa>_notatki_auto.json` w folderze ze schematem.

## Użycie
- `przegladarka_schematow.html` — otwórz w Chrome/Edge, wskaż PDF przyciskiem „Otwórz PDF” lub przeciągnij plik. (Wymaga dostępu do internetu do biblioteki pdf.js z cdnjs.)
- `wtyczka_chrome/` — rozszerzenie Chrome, które otwiera pliki `.pdf` w tej przeglądarce (biblioteka pdf.js dołączona lokalnie). Instrukcja instalacji: `wtyczka_chrome/INSTRUKCJA.txt` (chrome://extensions → Tryb dewelopera → „Załaduj rozpakowane”).

Uwaga: `wtyczka_chrome/viewer.*` to kopia `przegladarka_schematow.html` rozdzielona na pliki (wymóg rozszerzeń Chrome) — po zmianach w HTML trzeba ją odświeżyć.
